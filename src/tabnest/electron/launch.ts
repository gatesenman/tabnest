import { spawn } from 'node:child_process'
import { shell } from 'electron'
import log from 'electron-log/main'
import { discoverBrowsers } from './browsers/discover'

/** Open URLs in a specific browser (new window), or the system default when `browserId` is 'default'. */
export async function openIn(browserId: string, urls: string[], newWindow: boolean, profileId?: string | null): Promise<number> {
  if (browserId === 'default') {
    let n = 0
    for (const u of urls) {
      await shell.openExternal(u)
      n++
      await new Promise((r) => setTimeout(r, urls.length > 20 ? 250 : 120))
    }
    return n
  }
  const b = discoverBrowsers().find((x) => x.id === browserId)
  if (!b?.exe) throw new Error(`找不到 ${b?.name ?? browserId} 的程序文件`)
  const args: string[] = []
  if (b.family === 'firefox') {
    if (newWindow) args.push('-new-window', urls[0], ...urls.slice(1).flatMap((u) => ['-new-tab', u]))
    else args.push(...urls.flatMap((u) => ['-new-tab', u]))
  } else {
    if (profileId) args.push(`--profile-directory=${profileId}`)
    if (newWindow) args.push('--new-window')
    args.push(...urls)
  }
  // Chunk very long argument lists (Windows command line limit ~32k chars).
  const chunks: string[][] = []
  let cur: string[] = []
  let len = 0
  for (const a of args) {
    if (len + a.length > 24000 && cur.length) {
      chunks.push(cur)
      cur = b.family === 'chromium' && profileId ? [`--profile-directory=${profileId}`] : []
      len = 0
    }
    cur.push(a)
    len += a.length + 3
  }
  if (cur.length) chunks.push(cur)
  for (const c of chunks) {
    const child = spawn(b.exe, c, { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', (e) => log.error('launch failed', b.exe, e))
    child.unref()
    await new Promise((r) => setTimeout(r, 400))
  }
  return urls.length
}
