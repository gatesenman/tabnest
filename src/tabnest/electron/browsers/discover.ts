import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromiumBookmarksFile } from './bookmarkfile'
import { browserSpecs, firstExisting, type BrowserId, type BrowserSpec } from './paths'

export interface ProfileInfo {
  browserId: BrowserId
  browserName: string
  family: 'chromium' | 'firefox'
  profileId: string
  profileName: string
  path: string
  /** Estimated open-tab count from the latest session file's UpdateTabNavigation count (cheap heuristic). Exact after a real read. */
  liveHint: number | null
  hasBookmarks: boolean
  hasHistory: boolean
  lastActive: number | null
}

export interface BrowserInfo {
  id: BrowserId
  name: string
  family: 'chromium' | 'firefox'
  installed: boolean
  exe: string | null
  profiles: ProfileInfo[]
}

function chromiumProfiles(spec: BrowserSpec, root: string): ProfileInfo[] {
  let names: { id: string; name: string }[] = [{ id: 'Default', name: '默认' }]
  try {
    const local = JSON.parse(readFileSync(join(root, 'Local State'), 'utf-8')) as { profile?: { info_cache?: Record<string, { name?: string }> } }
    const cache = local.profile?.info_cache
    if (cache) names = Object.entries(cache).map(([id, v]) => ({ id, name: v.name || id }))
  } catch {
    // Fall back to directory scan.
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === 'Default' || d.name.startsWith('Profile')))
      .map((d) => ({ id: d.name, name: d.name === 'Default' ? '默认' : d.name }))
  }
  return names
    .map(({ id, name }): ProfileInfo | null => {
      const path = join(root, id)
      if (!existsSync(path)) return null
      const sessions = join(path, 'Sessions')
      const files = existsSync(sessions) ? readdirSync(sessions).filter((f) => /^(Session_|Tabs_)/.test(f) || /^(Current|Last) (Session|Tabs)$/.test(f)) : []
      let lastActive: number | null = null
      let liveHint: number | null = null
      for (const f of files) {
        try {
          const st = statSync(join(sessions, f))
          if (!lastActive || st.mtimeMs > lastActive) lastActive = st.mtimeMs
          if (/^Session_|^(Current|Last) Session$/.test(f) && st.size > 8) liveHint = Math.max(liveHint ?? 0, Math.floor((st.size - 8) / 80)) // rough
        } catch {
          /* ignore */
        }
      }
      return {
        browserId: spec.id,
        browserName: spec.name,
        family: 'chromium',
        profileId: id,
        profileName: name,
        path,
        liveHint,
        hasBookmarks: !!chromiumBookmarksFile(path),
        hasHistory: existsSync(join(path, 'History')),
        lastActive
      }
    })
    .filter((x): x is ProfileInfo => !!x)
}

function firefoxProfiles(spec: BrowserSpec, root: string): ProfileInfo[] {
  const ini = join(root, 'profiles.ini')
  if (!existsSync(ini)) return []
  const text = readFileSync(ini, 'utf-8')
  const out: ProfileInfo[] = []
  let cur: { name?: string; path?: string; isRelative?: boolean } = {}
  const flush = () => {
    if (!cur.path) return
    const path = cur.isRelative === false ? cur.path : join(root, cur.path)
    if (!existsSync(path)) return
    const backups = join(path, 'sessionstore-backups')
    let lastActive: number | null = null
    let liveHint: number | null = null
    for (const f of ['recovery.jsonlz4', 'recovery.baklz4', 'previous.jsonlz4']) {
      const p = join(backups, f)
      if (!existsSync(p)) continue
      try {
        const st = statSync(p)
        if (!lastActive || st.mtimeMs > lastActive) lastActive = st.mtimeMs
        liveHint = Math.max(liveHint ?? 0, Math.floor(st.size / 200))
      } catch {
        /* ignore */
      }
    }
    out.push({
      browserId: spec.id,
      browserName: spec.name,
      family: 'firefox',
      profileId: cur.path,
      profileName: cur.name || cur.path,
      path,
      liveHint,
      hasBookmarks: existsSync(join(path, 'places.sqlite')),
      hasHistory: existsSync(join(path, 'places.sqlite')),
      lastActive
    })
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\[Profile/.test(line)) {
      flush()
      cur = {}
    } else if (line.startsWith('Name=')) cur.name = line.slice(5)
    else if (line.startsWith('Path=')) cur.path = line.slice(5)
    else if (line.startsWith('IsRelative=')) cur.isRelative = line.slice(11) !== '0'
  }
  flush()
  return out
}

/** Detect which browsers are installed and list their profiles. Never throws. */
export function discoverBrowsers(platform: NodeJS.Platform = process.platform): BrowserInfo[] {
  return browserSpecs(platform).map((spec) => {
    const root = firstExisting(spec.roots)
    const exe = firstExisting(spec.exe)
    const profiles = root ? (spec.family === 'chromium' ? chromiumProfiles(spec, root) : firefoxProfiles(spec, root)) : []
    return { id: spec.id, name: spec.name, family: spec.family, installed: !!root || !!exe, exe, profiles }
  })
}
