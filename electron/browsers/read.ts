import { chromiumBookmarksFile, looksLikeJson } from './bookmarkfile'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import log from 'electron-log/main'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseRecentlyClosed, parseSession, type SessionWindow } from './snss'
import { readJsonLz4 } from './mozlz4'
import {
  countBookmarks,
  firefoxClosedTabs,
  firefoxOpenTabs,
  parseChromiumBookmarks,
  readChromiumHistory,
  readFirefoxBookmarks,
  readFirefoxHistory,
  type BookmarkNode,
  type FxSession,
  type HistoryItem
} from './parsers'
import type { ProfileInfo } from './discover'

export interface LiveTab {
  url: string
  title: string
  pinned: boolean
  windowIndex: number
  browserId: string
  browserName: string
  profileId: string
  profileName: string
  lastActive: number | null
}

export interface BrowserReadStatus {
  locked: boolean
  stale: boolean
  sourceMtime: number | null
  sourceFile: string | null
  /** tabs found in the file before filtering */
  rawTabs?: number
  /** browser-internal pages dropped */
  filtered?: number
}

export interface LiveCapture {
  /** per profileKey (browserId::profileId) */
  status: Record<string, BrowserReadStatus>
  tabs: LiveTab[]
  closed: LiveTab[]
  byBrowser: Record<string, number>
  windows: number
  capturedAt: string
}

export interface CopyIO {
  exists: (p: string) => boolean
  readFile: (p: string) => Buffer
  writeFile: (p: string, b: Buffer) => void
  /** chunked read via an explicit fd (different share-mode path on some Node/Windows builds) */
  readChunked: (p: string) => Buffer
  /** last resort (Windows only): PowerShell FileShare.ReadWrite|Delete copy */
  shellCopy: ((src: string, dest: string) => boolean) | null
  sleep: (ms: number) => void
  /** file signature (mtime+size) used to remember locked files; omit to disable the cache */
  sig?: (p: string) => string | null
}

/** Files that failed every copy strategy, keyed by path → signature. An unchanged locked file is skipped
 * instantly (no sync retries / PowerShell spawn blocking the main thread) for LOCK_TTL_MS. */
const lockedCache = new Map<string, { sig: string; at: number }>()
export const LOCK_TTL_MS = 5 * 60_000
export function clearLockedCache(): void {
  lockedCache.clear()
}

function sleepSync(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* ignore */
  }
}

function readChunkedSync(p: string): Buffer {
  const fd = openSync(p, constants.O_RDONLY)
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(1 << 20)
    let n: number
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, n)))
    return Buffer.concat(chunks)
  } finally {
    closeSync(fd)
  }
}

function psCopy(src: string, dest: string): boolean {
  const q = (x: string) => `'${x.replace(/'/g, "''")}'`
  const cmd = `$s=[IO.File]::Open(${q(src)},'Open','Read','ReadWrite,Delete');$d=[IO.File]::Create(${q(dest)});$s.CopyTo($d);$d.Close();$s.Close()`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 8000 })
  return r.status === 0 && existsSync(dest)
}

export const defaultIO: CopyIO = {
  exists: existsSync,
  readFile: (p) => readFileSync(p),
  writeFile: (p, b) => writeFileSync(p, b),
  readChunked: readChunkedSync,
  shellCopy: process.platform === 'win32' ? psCopy : null,
  sleep: sleepSync,
  sig: (p) => {
    try {
      const st = statSync(p)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }
}

export const RETRY_DELAYS = [50, 150, 400]

/**
 * Copy a possibly-locked browser file to a unique temp path. Never throws; null when unreadable.
 * Order: readFileSync (FILE_SHARE_READ|WRITE) → fd chunked read with 50/150/400 ms backoff →
 * Windows PowerShell share-all copy. NOTE: Edge/Vivaldi hold the *current* Session_* with an exclusive
 * lock — none of these succeed then; callers must fall back to older unlocked Session_/Tabs_ files (stale).
 */
export function copyLocked(src: string, label = 'file', io: CopyIO = defaultIO): string | null {
  if (!io.exists(src)) return null
  const sig = io.sig?.(src) ?? null
  const hit = sig ? lockedCache.get(src) : undefined
  if (hit && hit.sig === sig && Date.now() - hit.at < LOCK_TTL_MS) return null
  const dir = join(tmpdir(), 'tabnest-read')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  const dest = join(dir, `${label}-${randomUUID()}`)
  let lastErr: unknown
  try {
    io.writeFile(dest, io.readFile(src))
    return dest
  } catch (e) {
    lastErr = e
  }
  for (const ms of RETRY_DELAYS) {
    io.sleep(ms)
    try {
      io.writeFile(dest, io.readChunked(src))
      return dest
    } catch (e) {
      lastErr = e
    }
  }
  if (io.shellCopy)
    try {
      if (io.shellCopy(src, dest)) return dest
    } catch (e) {
      lastErr = e
    }
  if (sig) lockedCache.set(src, { sig, at: Date.now() })
  log.warn(`copyLocked: cannot read ${src} (${(lastErr as NodeJS.ErrnoException)?.code ?? lastErr})`)
  return null
}

function cleanup(p: string | null) {
  if (p)
    try {
      rmSync(p, { force: true })
    } catch {
      /* ignore */
    }
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export interface SessionFile {
  path: string
  kind: 'session' | 'tabs'
  mtime: number
}

/** All Session_* / Tabs_* (and legacy Current *) files, newest first. */
export function listSessionFiles(profile: string): SessionFile[] {
  const dir = join(profile, 'Sessions')
  const out: SessionFile[] = []
  const add = (p: string, kind: SessionFile['kind']) => {
    try {
      out.push({ path: p, kind, mtime: statSync(p).mtimeMs })
    } catch {
      /* ignore */
    }
  }
  if (existsSync(dir))
    for (const f of readdirSync(dir)) {
      if (/^Session_/.test(f)) add(join(dir, f), 'session')
      else if (/^Tabs_/.test(f)) add(join(dir, f), 'tabs')
    }
  for (const [f, k] of [
    ['Current Session', 'session'],
    ['Current Tabs', 'tabs'],
    ['Last Session', 'session'],
    ['Last Tabs', 'tabs']
  ] as const)
    if (existsSync(join(profile, f))) add(join(profile, f), k)
  return out.sort((a, b) => b.mtime - a.mtime)
}

export interface ChromiumRead {
  windows: SessionWindow[]
  closed: { url: string; title: string }[]
  /** true when the newest session file was locked and we fell back to an older one */
  stale: boolean
  /** mtime (ms) of the file the live tabs came from */
  sourceMtime: number | null
  /** newest Session_* was unreadable (browser running with exclusive lock) */
  locked: boolean
  sourceFile: string | null
}

const liveCount = (w: SessionWindow[]) => w.reduce((n, x) => n + x.tabs.length, 0)

/**
 * Pure selection logic (fs injected for tests). Walk files newest → oldest:
 *  - the first readable Session_* and the first readable Tabs_* are both parsed as sessions; the one
 *    with more live tabs wins (some forks keep live state mostly in one of them);
 *  - if the newest Session_* could not be read, result is marked locked + stale.
 */
export function pickChromiumSession(files: SessionFile[], read: (f: SessionFile) => Buffer | null): ChromiumRead {
  const res: ChromiumRead = { windows: [], closed: [], stale: false, sourceMtime: null, locked: false, sourceFile: null }
  const newestSession = files.find((f) => f.kind === 'session')
  const got: Partial<Record<SessionFile['kind'], { f: SessionFile; buf: Buffer }>> = {}
  for (const f of files) {
    if (got[f.kind]) continue
    const buf = read(f)
    if (!buf) {
      if (f === newestSession) res.locked = true
      continue
    }
    got[f.kind] = { f, buf }
    if (got.session && got.tabs) break
  }
  const tryParse = (b: Buffer) => {
    try {
      return parseSession(b)
    } catch {
      return []
    }
  }
  const s = got.session ? tryParse(got.session.buf) : []
  const t = got.tabs ? tryParse(got.tabs.buf) : []
  const useTabs = liveCount(t) > liveCount(s)
  const src = useTabs ? got.tabs : got.session
  res.windows = useTabs ? t : s
  if (src) {
    res.sourceMtime = src.f.mtime
    res.sourceFile = src.f.path
    const newestOfKind = files.find((f) => f.kind === src.f.kind)
    res.stale = res.locked || newestOfKind !== src.f
  }
  if (got.tabs)
    try {
      res.closed = parseRecentlyClosed(got.tabs.buf).map((n) => ({ url: n.url, title: n.title }))
    } catch {
      /* ignore */
    }
  return res
}

export function readChromiumOpenTabs(profile: ProfileInfo): ChromiumRead {
  return pickChromiumSession(listSessionFiles(profile.path), (f) => {
    const c = copyLocked(f.path, f.kind)
    if (!c) return null
    try {
      return readFileSync(c)
    } catch {
      return null
    } finally {
      cleanup(c)
    }
  })
}

const NOISE =
  /^(about:blank|about:newtab|chrome:\/\/newtab|chrome-search:|edge:\/\/newtab|vivaldi:\/\/(newtab|startpage)|opera:\/\/startpage|chrome:\/\/new-tab-page)/i

/** Keep http(s) tabs; drop browser-internal noise — unless that's all the user has (keep non-blank internals then). */
export function filterNoise<T extends { url: string }>(tabs: T[]): T[] {
  const http = tabs.filter((t) => isHttp(t.url))
  if (http.length) return http
  return tabs.filter((t) => t.url && !NOISE.test(t.url))
}

export function readFirefoxOpenTabs(profile: ProfileInfo): { tabs: ReturnType<typeof firefoxOpenTabs>; closed: ReturnType<typeof firefoxClosedTabs> } {
  const backups = join(profile.path, 'sessionstore-backups')
  const candidates = ['recovery.jsonlz4', 'recovery.baklz4', 'previous.jsonlz4'].map((f) => join(backups, f)).filter(existsSync)
  if (!candidates.length && existsSync(join(profile.path, 'sessionstore.jsonlz4'))) candidates.push(join(profile.path, 'sessionstore.jsonlz4'))
  for (const f of candidates) {
    const copy = copyLocked(f, 'fx')
    if (!copy) continue
    try {
      const session = readJsonLz4<FxSession>(readFileSync(copy))
      return { tabs: firefoxOpenTabs(session), closed: firefoxClosedTabs(session) }
    } catch {
      /* try next */
    } finally {
      cleanup(copy)
    }
  }
  return { tabs: [], closed: [] }
}

/** Capture currently-open tabs from one or more profiles. Always read-only. */
export function captureLive(profiles: ProfileInfo[], includeClosed = false): LiveCapture {
  const tabs: LiveTab[] = []
  const closed: LiveTab[] = []
  const status: Record<string, BrowserReadStatus> = {}
  let windows = 0
  for (const p of profiles) {
    try {
      if (p.family === 'chromium') {
        const r = readChromiumOpenTabs(p)
        status[`${p.browserId}::${p.profileId}`] = { locked: r.locked, stale: r.stale, sourceMtime: r.sourceMtime, sourceFile: r.sourceFile }
        windows += r.windows.length
        const st = status[`${p.browserId}::${p.profileId}`]
        st.rawTabs = 0
        st.filtered = 0
        r.windows.forEach((w, wi) => {
          const kept = filterNoise(w.tabs)
          st.rawTabs! += w.tabs.length
          st.filtered! += w.tabs.length - kept.length
          for (const t of kept) {
            tabs.push({
              url: t.url,
              title: t.title || t.url,
              pinned: t.pinned,
              windowIndex: wi,
              browserId: p.browserId,
              browserName: p.browserName,
              profileId: p.profileId,
              profileName: p.profileName,
              lastActive: t.lastActive
            })
          }
        })
        if (includeClosed)
          for (const c of r.closed)
            if (isHttp(c.url))
              closed.push({
                ...c,
                title: c.title || c.url,
                pinned: false,
                windowIndex: -1,
                browserId: p.browserId,
                browserName: p.browserName,
                profileId: p.profileId,
                profileName: p.profileName,
                lastActive: null
              })
      } else {
        const r = readFirefoxOpenTabs(p)
        const winSet = new Set(r.tabs.map((t) => t.windowIndex))
        windows += winSet.size
        const kept = r.tabs.filter((t) => isHttp(t.url))
        status[`${p.browserId}::${p.profileId}`] = {
          locked: false,
          stale: false,
          sourceMtime: null,
          sourceFile: null,
          rawTabs: r.tabs.length,
          filtered: r.tabs.length - kept.length
        }
        for (const t of kept) {
          tabs.push({
            url: t.url,
            title: t.title,
            pinned: t.pinned,
            windowIndex: t.windowIndex,
            browserId: p.browserId,
            browserName: p.browserName,
            profileId: p.profileId,
            profileName: p.profileName,
            lastActive: t.lastActive
          })
        }
        if (includeClosed)
          for (const c of r.closed)
            if (isHttp(c.url))
              closed.push({
                url: c.url,
                title: c.title,
                pinned: false,
                windowIndex: -1,
                browserId: p.browserId,
                browserName: p.browserName,
                profileId: p.profileId,
                profileName: p.profileName,
                lastActive: c.closedAt
              })
      }
    } catch {
      /* one bad profile must not abort the whole capture */
    }
  }
  const byBrowser: Record<string, number> = {}
  for (const t of tabs) byBrowser[t.browserId] = (byBrowser[t.browserId] ?? 0) + 1
  return { tabs, closed, byBrowser, windows, status, capturedAt: new Date().toISOString() }
}

export function readBookmarks(profile: ProfileInfo): BookmarkNode[] {
  if (profile.family === 'chromium') {
    const src = chromiumBookmarksFile(profile.path)
    if (!src) return []
    const copy = copyLocked(src, 'bookmarks')
    if (!copy) return []
    try {
      const text = readFileSync(copy, 'utf-8')
      if (!looksLikeJson(Buffer.from(text.slice(0, 16)))) {
        log.warn(`readBookmarks: ${src} is not plain JSON (encrypted/unknown format), skipped`)
        return []
      }
      return parseChromiumBookmarks(text)
    } catch (e) {
      log.warn(`readBookmarks: ${src} parse failed: ${e}`)
      return []
    } finally {
      cleanup(copy)
    }
  }
  const src = join(profile.path, 'places.sqlite')
  const copy = copyLocked(src, 'places')
  if (!copy) return []
  try {
    // Also copy -wal/-shm if present so we see the latest committed state.
    for (const s of ['-wal', '-shm']) {
      const w = src + s
      if (existsSync(w))
        try {
          copyFileSync(w, copy + s)
        } catch {
          /* ignore */
        }
    }
    return readFirefoxBookmarks(copy)
  } finally {
    cleanup(copy)
    for (const s of ['-wal', '-shm']) cleanup(copy + s)
  }
}

export function readHistory(profile: ProfileInfo, days = 7): HistoryItem[] {
  const since = Date.now() - days * 86400000
  if (profile.family === 'chromium') {
    const src = join(profile.path, 'History')
    const copy = copyLocked(src, 'history')
    if (!copy) return []
    try {
      return readChromiumHistory(copy, since)
    } finally {
      cleanup(copy)
    }
  }
  const src = join(profile.path, 'places.sqlite')
  const copy = copyLocked(src, 'places-h')
  if (!copy) return []
  try {
    for (const s of ['-wal', '-shm']) {
      const w = src + s
      if (existsSync(w))
        try {
          copyFileSync(w, copy + s)
        } catch {
          /* ignore */
        }
    }
    return readFirefoxHistory(copy, since)
  } finally {
    cleanup(copy)
    for (const s of ['-wal', '-shm']) cleanup(copy + s)
  }
}

export { countBookmarks }
