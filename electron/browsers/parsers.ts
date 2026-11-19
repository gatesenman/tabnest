import { safeIso } from '../../shared/time'
import Database from 'better-sqlite3'

export interface BookmarkNode {
  title: string
  url?: string
  addedAt?: string
  children?: BookmarkNode[]
}

// ---------- Chromium ----------

/** Chromium time: microseconds since 1601-01-01 UTC. */
export function chromeTimeToIso(v: string | number | bigint | undefined): string | undefined {
  if (v === undefined || v === null || v === '' || v === '0') return undefined
  const ms = Number(BigInt(v) / 1000n) - 11644473600000
  return safeIso(ms) ?? undefined
}

interface ChromiumNode {
  type?: string
  name?: string
  url?: string
  date_added?: string
  children?: ChromiumNode[]
}

const ROOT_NAMES: Record<string, string> = { bookmark_bar: '书签栏', other: '其他书签', synced: '移动设备书签' }

/** Chromium `Bookmarks` JSON → folder tree (empty roots dropped). */
export function parseChromiumBookmarks(json: string): BookmarkNode[] {
  const data = JSON.parse(json) as { roots?: Record<string, ChromiumNode> }
  if (!data?.roots) throw new Error('不是有效的 Chromium 书签文件')
  const conv = (n: ChromiumNode): BookmarkNode | null => {
    if (n.type === 'url') return n.url ? { title: n.name || n.url, url: n.url, addedAt: chromeTimeToIso(n.date_added) } : null
    const children = (n.children ?? []).map(conv).filter((x): x is BookmarkNode => !!x)
    return { title: n.name || '未命名文件夹', children }
  }
  const out: BookmarkNode[] = []
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const root = data.roots[key]
    if (!root) continue
    const node = conv(root)
    if (node?.children?.length) out.push({ ...node, title: ROOT_NAMES[key] })
  }
  return out
}

export interface HistoryItem {
  url: string
  title: string
  lastVisit: string
  visits: number
}

/** Chromium `History` sqlite (opened read-only from a temp copy). */
export function readChromiumHistory(file: string, sinceMs: number, limit = 2000): HistoryItem[] {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const since = (BigInt(sinceMs) + 11644473600000n) * 1000n
    const rows = db
      .prepare(
        'SELECT url, title, last_visit_time AS t, visit_count AS c FROM urls WHERE last_visit_time >= ? AND hidden = 0 ORDER BY last_visit_time DESC LIMIT ?'
      )
      .safeIntegers(true)
      .all(since, limit) as { url: string; title: string; t: bigint; c: bigint }[]
    return rows.map((r) => ({ url: r.url, title: r.title || r.url, lastVisit: chromeTimeToIso(r.t) ?? '', visits: Number(r.c) }))
  } finally {
    db.close()
  }
}

// ---------- Firefox ----------

interface FxEntry {
  url?: string
  title?: string
}
interface FxTab {
  entries?: FxEntry[]
  index?: number
  pinned?: boolean
  lastAccessed?: number
  hidden?: boolean
}
interface FxWindow {
  tabs?: FxTab[]
  selected?: number
  _closedTabs?: { state?: FxTab; closedAt?: number }[]
}
export interface FxSession {
  windows?: FxWindow[]
  _closedWindows?: FxWindow[]
}

export interface PlainTab {
  windowIndex: number
  url: string
  title: string
  pinned: boolean
  lastActive: number | null
}

const fxCurrent = (t: FxTab): FxEntry | undefined => {
  const e = t.entries ?? []
  if (!e.length) return undefined
  const i = Math.min(Math.max((t.index ?? e.length) - 1, 0), e.length - 1) // index is 1-based
  return e[i]
}

export function firefoxOpenTabs(s: FxSession): PlainTab[] {
  const out: PlainTab[] = []
  ;(s.windows ?? []).forEach((w, wi) => {
    for (const t of w.tabs ?? []) {
      const e = fxCurrent(t)
      if (e?.url && !t.hidden) out.push({ windowIndex: wi, url: e.url, title: e.title || e.url, pinned: !!t.pinned, lastActive: t.lastAccessed ?? null })
    }
  })
  return out
}

export function firefoxClosedTabs(s: FxSession): { url: string; title: string; closedAt: number | null }[] {
  const out: { url: string; title: string; closedAt: number | null }[] = []
  for (const w of s.windows ?? [])
    for (const c of w._closedTabs ?? []) {
      const e = c.state && fxCurrent(c.state)
      if (e?.url) out.push({ url: e.url, title: e.title || e.url, closedAt: c.closedAt ?? null })
    }
  for (const w of s._closedWindows ?? [])
    for (const t of w.tabs ?? []) {
      const e = fxCurrent(t)
      if (e?.url) out.push({ url: e.url, title: e.title || e.url, closedAt: null })
    }
  return out
}

/** Firefox places.sqlite bookmarks (menu / toolbar / unfiled / mobile roots) as a folder tree. */
export function readFirefoxBookmarks(file: string): BookmarkNode[] {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        `SELECT b.id, b.type, b.parent, b.position, b.title, b.dateAdded AS added, b.guid, p.url
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position`
      )
      .all() as { id: number; type: number; parent: number; title: string | null; added: number | null; guid: string; url: string | null }[]
    const kids = new Map<number, typeof rows>()
    for (const r of rows) {
      const arr = kids.get(r.parent)
      if (arr) arr.push(r)
      else kids.set(r.parent, [r])
    }
    const build = (id: number): BookmarkNode[] =>
      (kids.get(id) ?? [])
        .map((r): BookmarkNode | null => {
          if (r.type === 1)
            return r.url && !r.url.startsWith('place:')
              ? { title: r.title || r.url, url: r.url, addedAt: r.added ? new Date(r.added / 1000).toISOString() : undefined }
              : null
          if (r.type === 2) return { title: r.title || '未命名文件夹', children: build(r.id) }
          return null // separators
        })
        .filter((x): x is BookmarkNode => !!x)
    const roots: [string, string][] = [
      ['toolbar_____', '书签工具栏'],
      ['menu________', '书签菜单'],
      ['unfiled_____', '其他书签'],
      ['mobile______', '移动设备书签']
    ]
    const out: BookmarkNode[] = []
    for (const [guid, name] of roots) {
      const r = rows.find((x) => x.guid === guid)
      if (!r) continue
      const children = build(r.id)
      if (children.length) out.push({ title: name, children })
    }
    return out
  } finally {
    db.close()
  }
}

export function readFirefoxHistory(file: string, sinceMs: number, limit = 2000): HistoryItem[] {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        'SELECT url, title, last_visit_date AS t, visit_count AS c FROM moz_places WHERE last_visit_date >= ? AND hidden = 0 ORDER BY last_visit_date DESC LIMIT ?'
      )
      .all(sinceMs * 1000, limit) as { url: string; title: string | null; t: number; c: number }[]
    return rows.map((r) => ({ url: r.url, title: r.title || r.url, lastVisit: new Date(r.t / 1000).toISOString(), visits: r.c }))
  } finally {
    db.close()
  }
}

export function countBookmarks(nodes: BookmarkNode[]): number {
  return nodes.reduce((n, x) => n + (x.url ? 1 : countBookmarks(x.children ?? [])), 0)
}
