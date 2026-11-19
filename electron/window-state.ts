import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { Repo } from './db'

interface State {
  bounds: Rectangle
  maximized: boolean
}

export function loadWindowState(repo: Repo): State {
  const fallback: State = { bounds: { x: NaN, y: NaN, width: 1240, height: 800 }, maximized: false }
  try {
    const s = JSON.parse(repo.getSetting('windowState') ?? 'null') as State | null
    if (!s) return fallback
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return s.bounds.x >= a.x - 50 && s.bounds.y >= a.y - 50 && s.bounds.x < a.x + a.width && s.bounds.y < a.y + a.height
    })
    return visible ? s : { ...fallback, bounds: { ...fallback.bounds, width: s.bounds.width, height: s.bounds.height } }
  } catch {
    return fallback
  }
}

export function trackWindowState(win: BrowserWindow, repo: Repo): void {
  let t: NodeJS.Timeout | undefined
  const save = () => {
    clearTimeout(t)
    t = setTimeout(() => {
      if (win.isDestroyed()) return
      repo.setSetting('windowState', JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }))
    }, 400)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
  win.on('close', () => {
    clearTimeout(t)
    repo.setSetting('windowState', JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }))
  })
}
