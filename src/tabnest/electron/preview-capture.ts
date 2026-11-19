import { BrowserWindow, session } from 'electron'
import log from 'electron-log/main'
import type { CaptureFn } from './preview'
import { PREVIEW_WIDTH } from './preview'

const PARTITION = 'tabnest-preview' // no "persist:" prefix → in-memory, never shares cookies with the main session
const VIEW_W = 1280
const VIEW_H = 800
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/**
 * Hidden offscreen window that loads a page and grabs a 480×300 JPEG. Audio muted, popups/downloads/permissions denied,
 * separate in-memory session (cleared periodically). One window, reused; captures are serialised by the caller.
 */
export function createCapture(o: { timeoutMs?: number; settleMs?: number } = {}): { capture: CaptureFn; dispose: () => void } {
  let win: BrowserWindow | null = null
  let n = 0
  const ses = session.fromPartition(PARTITION, { cache: true })
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  ses.setUserAgent(UA, 'zh-CN,zh;q=0.9,en;q=0.8')

  const ensure = () => {
    if (win && !win.isDestroyed()) return win
    win = new BrowserWindow({
      show: false,
      width: VIEW_W,
      height: VIEW_H,
      skipTaskbar: true,
      focusable: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: PARTITION,
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        webgl: false,
        autoplayPolicy: 'document-user-activation-required'
      }
    })
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.setFrameRate(4)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-prevent-unload', (e) => e.preventDefault())
    wc.on('render-process-gone', () => {
      win?.destroy()
      win = null
    })
    return win
  }

  const capture: CaptureFn = async (url) => {
    const w = ensure()
    const wc = w.webContents
    const timeout = o.timeoutMs ?? 15000
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        wc.loadURL(url, { userAgent: UA }).catch((e: Error & { code?: string; errno?: number }) => {
          // redirects / client navigations abort the first load; anything else is a real failure
          if (e.errno === -3 || /ERR_ABORTED/.test(e.message)) return
          throw new Error(e.code ?? e.message)
        }),
        new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('超时')), timeout)))
      ])
      await new Promise((r) => setTimeout(r, o.settleMs ?? 1500))
      const img = await wc.capturePage({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })
      if (img.isEmpty()) throw new Error('空白截图')
      const small = img.resize({ width: PREVIEW_WIDTH, height: Math.round((PREVIEW_WIDTH * VIEW_H) / VIEW_W), quality: 'good' })
      return small.toJPEG(72)
    } finally {
      clearTimeout(timer)
      wc.stop()
      void wc.loadURL('about:blank').catch(() => undefined)
      if (++n % 25 === 0) void ses.clearStorageData().catch(() => undefined)
    }
  }
  const dispose = () => {
    try {
      win?.destroy()
    } catch (e) {
      log.warn('preview dispose', e)
    }
    win = null
    void ses.clearStorageData().catch(() => undefined)
  }
  return { capture, dispose }
}
