import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import log from 'electron-log/main'

const exec = promisify(execFile)

export interface CloseResult {
  id: string
  process: string
  closed: boolean
  forced: boolean
  error?: string
}

const NAMES: Record<string, { win: string; mac: string; linux: string[] }> = {
  chrome: { win: 'chrome.exe', mac: 'Google Chrome', linux: ['google-chrome', 'chrome', 'chromium', 'chromium-browser'] },
  edge: { win: 'msedge.exe', mac: 'Microsoft Edge', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  brave: { win: 'brave.exe', mac: 'Brave Browser', linux: ['brave', 'brave-browser'] },
  vivaldi: { win: 'vivaldi.exe', mac: 'Vivaldi', linux: ['vivaldi', 'vivaldi-stable'] },
  opera: { win: 'opera.exe', mac: 'Opera', linux: ['opera'] },
  chromium: { win: 'chrome.exe', mac: 'Chromium', linux: ['chromium', 'chromium-browser'] },
  qqbrowser: { win: 'QQBrowser.exe', mac: 'QQBrowser', linux: [] },
  '360se': { win: '360se.exe', mac: '', linux: [] },
  '360chrome': { win: '360ChromeX.exe', mac: '', linux: [] },
  sogou: { win: 'SogouExplorer.exe', mac: '', linux: [] },
  '2345': { win: '2345Explorer.exe', mac: '', linux: [] },
  liebao: { win: 'liebao.exe', mac: '', linux: [] },
  quark: { win: 'quark.exe', mac: '', linux: [] },
  lenovo: { win: 'SLBrowser.exe', mac: '', linux: [] },
  firefox: { win: 'firefox.exe', mac: 'Firefox', linux: ['firefox'] }
}

async function runningWin(exe: string): Promise<boolean> {
  try {
    const { stdout } = await exec('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'])
    return stdout.toLowerCase().includes(exe.toLowerCase())
  } catch {
    return false
  }
}

async function runningUnix(names: string[]): Promise<boolean> {
  try {
    const { stdout } = await exec('pgrep', ['-x', names.join('|')])
    return !!stdout.trim()
  } catch {
    try {
      const { stdout } = await exec('ps', ['-A', '-o', 'comm='])
      const set = new Set(stdout.split(/\n/).map((s) => s.trim()))
      return names.some((n) => set.has(n))
    } catch {
      return false
    }
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Gracefully quit browsers. Windows: `taskkill` without `/F` (sends WM_CLOSE so Chrome/Firefox
 * can flush their own session). Wait up to 10s, then force. macOS: AppleScript quit. Linux: SIGTERM then SIGKILL.
 * Never throws — each browser's result is reported separately.
 */
export async function closeBrowsers(ids: string[]): Promise<CloseResult[]> {
  const out: CloseResult[] = []
  for (const id of ids) {
    const spec = NAMES[id]
    if (!spec) {
      out.push({ id, process: id, closed: false, forced: false, error: '未知浏览器' })
      continue
    }
    if ((process.platform === 'darwin' && !spec.mac) || (process.platform !== 'win32' && process.platform !== 'darwin' && !spec.linux.length)) {
      out.push({ id, process: id, closed: false, forced: false, error: '此平台不支持自动关闭该浏览器' })
      continue
    }
    try {
      if (process.platform === 'win32') {
        const was = await runningWin(spec.win)
        if (!was) {
          out.push({ id, process: spec.win, closed: true, forced: false })
          continue
        }
        await exec('taskkill', ['/IM', spec.win]).catch(() => undefined)
        let forced = false
        for (let i = 0; i < 20; i++) {
          await sleep(500)
          if (!(await runningWin(spec.win))) break
          if (i === 19) {
            await exec('taskkill', ['/F', '/IM', spec.win]).catch(() => undefined)
            forced = true
            await sleep(500)
          }
        }
        out.push({ id, process: spec.win, closed: !(await runningWin(spec.win)), forced })
      } else if (process.platform === 'darwin') {
        await exec('osascript', ['-e', `tell application "${spec.mac}" to quit`]).catch(() => undefined)
        await sleep(3000)
        let forced = false
        try {
          await exec('pgrep', ['-x', spec.mac])
          await exec('pkill', ['-9', '-x', spec.mac]).catch(() => undefined)
          forced = true
        } catch {
          /* already gone */
        }
        out.push({ id, process: spec.mac, closed: true, forced })
      } else {
        const was = await runningUnix(spec.linux)
        if (!was) {
          out.push({ id, process: spec.linux[0], closed: true, forced: false })
          continue
        }
        for (const n of spec.linux) await exec('pkill', ['-TERM', '-x', n]).catch(() => undefined)
        let forced = false
        for (let i = 0; i < 20; i++) {
          await sleep(500)
          if (!(await runningUnix(spec.linux))) break
          if (i === 19) {
            for (const n of spec.linux) await exec('pkill', ['-KILL', '-x', n]).catch(() => undefined)
            forced = true
          }
        }
        out.push({ id, process: spec.linux[0], closed: !(await runningUnix(spec.linux)), forced })
      }
    } catch (e) {
      log.error('close browser failed', id, e)
      out.push({ id, process: spec.win, closed: false, forced: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

/** Soft request to shut the computer down (Windows shutdown /s /t 30; Linux systemctl; macOS AppleScript). */
export async function shutdownComputer(): Promise<void> {
  if (process.platform === 'win32') await exec('shutdown', ['/s', '/t', '30', '/c', 'TabNest 已保存标签，30 秒后关机'])
  else if (process.platform === 'darwin') await exec('osascript', ['-e', 'tell application "System Events" to shut down'])
  else await exec('systemctl', ['poweroff']).catch(() => exec('shutdown', ['-h', '+1']))
}

/** Which known browsers have a running process right now (null if the platform query failed). */
export async function runningBrowserIds(): Promise<Set<string> | null> {
  const out = new Set<string>()
  try {
    for (const [id, spec] of Object.entries(NAMES)) {
      if (id === 'chromium' && process.platform === 'win32') continue
      const on =
        process.platform === 'win32'
          ? await runningWin(spec.win)
          : process.platform === 'darwin'
            ? await runningUnix([spec.mac])
            : await runningUnix(spec.linux)
      if (on) out.add(id)
    }
    return out
  } catch {
    return null
  }
}
