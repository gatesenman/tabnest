import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Collection, DuplicateGroup, LinkStatus, NewTabInput, Session, Snapshot, TabItem } from '../shared/types'
import { BUILTIN_FOLDERS } from '../shared/types'
import { extractDomain, faviconFor, normalizeUrl } from '../shared/url'
import type { UndoData } from '../shared/autoorg/engine'
import { AiStore } from './ai/store'

type Row = Record<string, unknown>
export interface BookmarkInput {
  title: string
  url?: string
  addedAt?: string
  children?: BookmarkInput[]
}

/** Ordered schema migrations; index + 1 === PRAGMA user_version after applying. */
export type Migration = string | ((db: Database.Database) => void)
export const MIGRATIONS: Migration[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', group_names TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE collections (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
     builtin INTEGER NOT NULL DEFAULT 0, parent_id TEXT REFERENCES collections(id) ON DELETE SET NULL, sort INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE tabs (
     id TEXT PRIMARY KEY,
     session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
     collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
     title TEXT NOT NULL, url TEXT NOT NULL, norm_url TEXT NOT NULL, domain TEXT NOT NULL,
     favicon TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, group_name TEXT,
     description TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '[]',
     link_status TEXT NOT NULL DEFAULT 'unknown', link_code INTEGER, link_note TEXT, last_checked_at TEXT);
   CREATE INDEX idx_tabs_session ON tabs(session_id);
   CREATE INDEX idx_tabs_collection ON tabs(collection_id);
   CREATE INDEX idx_tabs_norm ON tabs(norm_url);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE VIRTUAL TABLE tabs_fts USING fts5(tab_id UNINDEXED, title, url, description, keywords, tokenize='trigram');
   INSERT INTO tabs_fts(tab_id, title, url, description, keywords) SELECT id, title, url, description, keywords FROM tabs;
   CREATE TRIGGER tabs_ai AFTER INSERT ON tabs BEGIN
     INSERT INTO tabs_fts(tab_id, title, url, description, keywords) VALUES (new.id, new.title, new.url, new.description, new.keywords);
   END;
   CREATE TRIGGER tabs_ad AFTER DELETE ON tabs BEGIN DELETE FROM tabs_fts WHERE tab_id = old.id; END;
   CREATE TRIGGER tabs_au AFTER UPDATE OF title, url, description, keywords ON tabs BEGIN
     UPDATE tabs_fts SET title = new.title, url = new.url, description = new.description, keywords = new.keywords WHERE tab_id = new.id;
   END;`,
  `ALTER TABLE tabs ADD COLUMN browser_id TEXT;
   ALTER TABLE tabs ADD COLUMN profile_id TEXT;
   ALTER TABLE tabs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tabs ADD COLUMN last_active_at TEXT;
   ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
   ALTER TABLE sessions ADD COLUMN source_summary TEXT NOT NULL DEFAULT '';
   ALTER TABLE sessions ADD COLUMN added_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN removed_count INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX idx_collections_parent ON collections(parent_id);`,
  `ALTER TABLE tabs ADD COLUMN organized_at TEXT;
   UPDATE tabs SET organized_at = created_at WHERE collection_id IS NOT NULL;`,
  `ALTER TABLE sessions ADD COLUMN day TEXT;
   CREATE INDEX idx_sessions_day ON sessions(day);
   CREATE TABLE snapshot_items (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
     title TEXT NOT NULL DEFAULT '',
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     seen_count INTEGER NOT NULL DEFAULT 1,
     sources TEXT NOT NULL DEFAULT '[]',
     PRIMARY KEY (session_id, tab_id));
   CREATE INDEX idx_items_tab ON snapshot_items(tab_id);`,
  mergeSessionsPerDay,
  `ALTER TABLE tabs ADD COLUMN note TEXT NOT NULL DEFAULT '';
   CREATE TABLE trash (id TEXT PRIMARY KEY, data TEXT NOT NULL, deleted_at TEXT NOT NULL);
   CREATE INDEX idx_trash_at ON trash(deleted_at);`,
  `CREATE TABLE org_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
     data TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'local', undone INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX idx_org_log_at ON org_log(at);`,
  // v1.3.1: who placed a bookmark into its folder ('import' | 'ai' | 'user'). Imported ones stay eligible for AI re-sorting.
  `ALTER TABLE tabs ADD COLUMN placed_by TEXT;
   WITH RECURSIVE imp(id) AS (
     SELECT id FROM collections WHERE note LIKE '来源：%' OR note LIKE '从 % 导入%'
     UNION SELECT c.id FROM collections c JOIN imp ON c.parent_id = imp.id)
   UPDATE tabs SET placed_by = 'import' WHERE collection_id IN (SELECT id FROM imp);`,
  // v1.3.1: AI enrichment metadata (topics, one-line summary, language) + FTS over all AI fields.
  `ALTER TABLE tabs ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE tabs ADD COLUMN summary TEXT NOT NULL DEFAULT '';
   ALTER TABLE tabs ADD COLUMN lang TEXT NOT NULL DEFAULT '';
   ALTER TABLE tabs ADD COLUMN enriched_at TEXT;
   ALTER TABLE tabs ADD COLUMN enriched_by TEXT;
   ALTER TABLE tabs ADD COLUMN enriched_sig TEXT;
   DROP TRIGGER IF EXISTS tabs_ai;
   DROP TRIGGER IF EXISTS tabs_ad;
   DROP TRIGGER IF EXISTS tabs_au;
   DROP TABLE IF EXISTS tabs_fts;
   CREATE VIRTUAL TABLE tabs_fts USING fts5(tab_id UNINDEXED, title, url, description, keywords, topics, summary, tokenize='trigram');
   INSERT INTO tabs_fts(tab_id, title, url, description, keywords, topics, summary) SELECT id, title, url, description, keywords, topics, summary FROM tabs;
   CREATE TRIGGER tabs_ai AFTER INSERT ON tabs BEGIN
     INSERT INTO tabs_fts(tab_id, title, url, description, keywords, topics, summary) VALUES (new.id, new.title, new.url, new.description, new.keywords, new.topics, new.summary);
   END;
   CREATE TRIGGER tabs_ad AFTER DELETE ON tabs BEGIN DELETE FROM tabs_fts WHERE tab_id = old.id; END;
   CREATE TRIGGER tabs_au AFTER UPDATE OF title, url, description, keywords, topics, summary ON tabs BEGIN
     UPDATE tabs_fts SET title = new.title, url = new.url, description = new.description, keywords = new.keywords, topics = new.topics, summary = new.summary WHERE tab_id = new.id;
   END;
   CREATE INDEX idx_tabs_enriched ON tabs(enriched_at);`,
  // v1.4.0: content-aware AI. Page text + vectors live in a side table (keeps snapshot() light); FTS gains page content.
  `ALTER TABLE tabs ADD COLUMN enrich_v INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tabs ADD COLUMN org_reason TEXT;
   CREATE TABLE tab_ai (
     tab_id TEXT PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
     content TEXT NOT NULL DEFAULT '', content_hash TEXT, fetched_at TEXT, fetch_status TEXT,
     vec BLOB, emb BLOB, emb_model TEXT);
   CREATE TABLE ai_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
   DROP TRIGGER IF EXISTS tabs_ai;
   DROP TRIGGER IF EXISTS tabs_ad;
   DROP TRIGGER IF EXISTS tabs_au;
   DROP TABLE IF EXISTS tabs_fts;
   CREATE VIRTUAL TABLE tabs_fts USING fts5(tab_id UNINDEXED, title, url, description, keywords, topics, summary, content, tokenize='trigram');
   INSERT INTO tabs_fts(tab_id, title, url, description, keywords, topics, summary, content) SELECT id, title, url, description, keywords, topics, summary, '' FROM tabs;
   CREATE TRIGGER tabs_ai AFTER INSERT ON tabs BEGIN
     INSERT INTO tabs_fts(tab_id, title, url, description, keywords, topics, summary, content) VALUES (new.id, new.title, new.url, new.description, new.keywords, new.topics, new.summary, '');
   END;
   CREATE TRIGGER tabs_ad AFTER DELETE ON tabs BEGIN DELETE FROM tabs_fts WHERE tab_id = old.id; END;
   CREATE TRIGGER tabs_au AFTER UPDATE OF title, url, description, keywords, topics, summary ON tabs BEGIN
     UPDATE tabs_fts SET title = new.title, url = new.url, description = new.description, keywords = new.keywords, topics = new.topics, summary = new.summary WHERE tab_id = new.id;
   END;
   CREATE TRIGGER tab_ai_ins AFTER INSERT ON tab_ai BEGIN UPDATE tabs_fts SET content = new.content WHERE tab_id = new.tab_id; END;
   CREATE TRIGGER tab_ai_upd AFTER UPDATE OF content ON tab_ai BEGIN UPDATE tabs_fts SET content = new.content WHERE tab_id = new.tab_id; END;`,
  // v1.4.1: structured AI summary (key points, source, engine label). ENRICH_VERSION 3 re-summarizes in the background.
  `ALTER TABLE tab_ai ADD COLUMN points TEXT;
   ALTER TABLE tab_ai ADD COLUMN summary_src TEXT;
   ALTER TABLE tab_ai ADD COLUMN engine TEXT;
   ALTER TABLE tab_ai ADD COLUMN summarized_at TEXT;`,
  // v1.4.2: page preview screenshot cache (files under userData/previews, index here)
  `CREATE TABLE previews (
     url_hash TEXT PRIMARY KEY, url TEXT NOT NULL, path TEXT, captured_at TEXT, status TEXT NOT NULL,
     fails INTEGER NOT NULL DEFAULT 0, next_try TEXT, error TEXT, bytes INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX idx_previews_url ON previews(url);`
]

export interface OrgLogEntry {
  id: string
  at: string
  kind: string
  summary: string
  engine: string
  undone: boolean
  data: UndoData
}

/** Local calendar day (YYYY-MM-DD) in the machine's time zone. */
export function localDay(d: Date | string = new Date()): string {
  const x = typeof d === 'string' ? new Date(d) : d
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
}

export function dayTitle(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const wd = '日一二三四五六'[new Date(y, m - 1, d).getDay()]
  return `${m}月${d}日 周${wd}`
}

/** Bump to re-enrich everything once (1.4.0: page-content aware enrichment). */
export const ENRICH_VERSION = 3

const CAPTURE_KINDS = "('manual','auto','extension','history','daily')"

/**
 * Migration 6: every capture-like session becomes part of one "daily snapshot" per local day.
 * Inside a day, tabs with the same normalized URL collapse into one snapshot item; unsorted duplicate
 * tab rows are merged (organized rows always stay linked to their folder).
 */
export function mergeSessionsPerDay(db: Database.Database): void {
  const sessions = db.prepare(`SELECT * FROM sessions WHERE kind IN ${CAPTURE_KINDS} ORDER BY created_at`).all() as Row[]
  const byDay = new Map<string, Row[]>()
  for (const s of sessions) {
    const d = localDay(s.created_at as string)
    const arr = byDay.get(d)
    if (arr) arr.push(s)
    else byDay.set(d, [s])
  }
  const tabsOf = db.prepare('SELECT * FROM tabs WHERE session_id = ? ORDER BY created_at, rowid')
  const insItem = db.prepare(
    'INSERT INTO snapshot_items (session_id, tab_id, title, first_seen_at, last_seen_at, seen_count, sources) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, tab_id) DO UPDATE SET seen_count = seen_count + excluded.seen_count, last_seen_at = MAX(last_seen_at, excluded.last_seen_at), title = excluded.title'
  )
  for (const [day, group] of byDay) {
    const keep = group[0]
    const sid = keep.id as string
    const kinds = new Set(group.map((g) => g.kind as string))
    db.prepare("UPDATE sessions SET day = ?, kind = 'daily', name = ?, source_summary = ? WHERE id = ?").run(
      day,
      dayTitle(day),
      [...kinds].filter((k) => k !== 'daily').join(','),
      sid
    )
    const winner = new Map<string, string>() // norm_url -> tab id kept for this day
    for (const s of group) {
      for (const t of tabsOf.all(s.id) as Row[]) {
        const k = t.norm_url as string
        const at = t.created_at as string
        const src = t.browser_id ? JSON.stringify([`${t.browser_id}::${t.profile_id ?? ''}`]) : '[]'
        const existing = winner.get(k)
        if (existing && existing !== t.id && t.collection_id == null) {
          // duplicate unsorted row inside the same day: fold into the winner
          insItem.run(sid, existing, t.title, at, at, 1, src)
          db.prepare('DELETE FROM tabs WHERE id = ?').run(t.id)
          continue
        }
        if (!existing) winner.set(k, t.id as string)
        db.prepare('UPDATE tabs SET session_id = ? WHERE id = ?').run(sid, t.id)
        insItem.run(sid, t.id, t.title, at, at, 1, src)
      }
      if (s.id !== sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id)
    }
  }
  // Across days: an unsorted URL should exist only once in the library; re-point items to the oldest row.
  const dups = db.prepare('SELECT norm_url FROM tabs WHERE collection_id IS NULL GROUP BY norm_url HAVING COUNT(*) > 1').all() as Row[]
  for (const d of dups) {
    const rows = db.prepare('SELECT id FROM tabs WHERE collection_id IS NULL AND norm_url = ? ORDER BY created_at, rowid').all(d.norm_url) as Row[]
    const [first, ...rest] = rows.map((r) => r.id as string)
    for (const id of rest) {
      db.prepare('UPDATE OR IGNORE snapshot_items SET tab_id = ? WHERE tab_id = ?').run(first, id)
      db.prepare('DELETE FROM tabs WHERE id = ?').run(id)
    }
  }
}

export interface CaptureTab extends NewTabInput {
  source: string
}

export interface CaptureOutcome {
  sessionId: string
  day: string
  captured: number
  newToday: number
  newOverall: number
  dayTotal: number
}

export interface SnapshotItem {
  sessionId: string
  tabId: string
  title: string
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
  sources: string[]
}

function toTab(r: Row): TabItem {
  return {
    id: r.id as string,
    sessionId: (r.session_id as string) ?? null,
    collectionId: (r.collection_id as string) ?? null,
    title: r.title as string,
    url: r.url as string,
    normUrl: r.norm_url as string,
    domain: r.domain as string,
    favicon: r.favicon as string,
    createdAt: r.created_at as string,
    groupName: (r.group_name as string) ?? null,
    description: r.description as string,
    keywords: JSON.parse((r.keywords as string) || '[]') as string[],
    linkStatus: r.link_status as LinkStatus,
    linkStatusCode: (r.link_code as number) ?? null,
    linkStatusNote: (r.link_note as string) ?? null,
    lastCheckedAt: (r.last_checked_at as string) ?? null,
    browserId: (r.browser_id as string) ?? null,
    profileId: (r.profile_id as string) ?? null,
    pinned: !!r.pinned,
    lastActiveAt: (r.last_active_at as string) ?? null,
    note: (r.note as string) ?? '',
    organizedAt: (r.organized_at as string) ?? null,
    topics: JSON.parse((r.topics as string) || '[]') as string[],
    summary: (r.summary as string) ?? '',
    lang: (r.lang as string) ?? '',
    enrichedAt: (r.enriched_at as string) ?? null,
    enrichedBy: ((r.enriched_by as string) ?? null) as TabItem['enrichedBy'],
    enrichStale: !!r.enriched_at && r.enriched_sig !== `${r.title as string}\n${r.url as string}`,
    orgReason: (r.org_reason as string) ?? null
  }
}

function toSession(r: Row): Session {
  return {
    id: r.id as string,
    name: r.name as string,
    createdAt: r.created_at as string,
    note: r.note as string,
    tags: JSON.parse(r.tags as string) as string[],
    groupNames: JSON.parse(r.group_names as string) as Record<string, string>,
    kind: (r.kind as Session['kind']) || 'manual',
    sourceSummary: (r.source_summary as string) || '',
    addedCount: (r.added_count as number) || 0,
    removedCount: (r.removed_count as number) || 0,
    day: (r.day as string) ?? null,
    itemCount: 0
  }
}

function toCollection(r: Row): Collection {
  return {
    id: r.id as string,
    name: r.name as string,
    createdAt: r.created_at as string,
    note: r.note as string,
    builtin: !!r.builtin,
    parentId: (r.parent_id as string) ?? null,
    sort: r.sort as number
  }
}

function chunk<T>(arr: T[], n = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export class Repo {
  readonly db: Database.Database
  /** AI side data: page text, vectors, cloud cache, natural-language search */
  readonly ai: AiStore

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
    this.ensureBuiltinFolders()
    this.ai = new AiStore(this.db)
  }

  close(): void {
    this.db.close()
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  private migrate(): void {
    const current = this.schemaVersion
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        const m = MIGRATIONS[v]
        if (typeof m === 'string') this.db.exec(m)
        else m(this.db)
        this.db.pragma(`user_version = ${v + 1}`)
      })()
    }
  }

  private ensureBuiltinFolders(): void {
    const existing = new Set((this.db.prepare('SELECT name FROM collections').all() as Row[]).map((r) => r.name as string))
    const ins = this.db.prepare('INSERT INTO collections (id, name, created_at, note, builtin, sort) VALUES (?, ?, ?, ?, 1, ?)')
    BUILTIN_FOLDERS.forEach((f, i) => {
      if (!existing.has(f.name)) ins.run(randomUUID(), f.name, new Date().toISOString(), f.note, i)
    })
  }

  isEmpty(): boolean {
    return (this.db.prepare('SELECT COUNT(*) c FROM sessions').get() as Row).c === 0
  }

  // ---- settings (raw key/value) ----
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined
    return r ? (r.value as string) : null
  }
  setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---- reads ----
  snapshot(): Snapshot {
    return {
      sessions: (() => {
        const stats = this.dayStats()
        return (this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as Row[]).map((r) => {
          const s = toSession(r)
          const st = stats.get(s.id)
          return st ? { ...s, addedCount: st.newVsPrev, itemCount: st.total } : { ...s, itemCount: 0 }
        })
      })(),
      items: this.items(),
      trash: this.trashList(),
      collections: (this.db.prepare('SELECT * FROM collections ORDER BY builtin DESC, sort, created_at').all() as Row[]).map(toCollection),
      tabs: (this.db.prepare('SELECT * FROM tabs ORDER BY created_at, rowid').all() as Row[]).map(toTab),
      onboardingDone: this.getSetting('onboardingDone') === '1'
    }
  }

  getTabs(tabIds: string[]): TabItem[] {
    const out: TabItem[] = []
    for (const part of chunk(tabIds)) {
      const q = `SELECT * FROM tabs WHERE id IN (${part.map(() => '?').join(',')})`
      out.push(...(this.db.prepare(q).all(...part) as Row[]).map(toTab))
    }
    return out
  }

  // ---- sessions ----
  createSession(input: {
    name: string
    note?: string
    tags?: string[]
    createdAt?: string
    tabs: NewTabInput[]
    collectionId?: string | null
    kind?: Session['kind']
    sourceSummary?: string
    addedCount?: number
    removedCount?: number
  }): string {
    const sid = randomUUID()
    const createdAt = input.createdAt ?? new Date().toISOString()
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO sessions (id, name, created_at, note, tags, kind, source_summary, added_count, removed_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          sid,
          input.name,
          createdAt,
          input.note ?? '',
          JSON.stringify(input.tags ?? []),
          input.kind ?? 'manual',
          input.sourceSummary ?? '',
          input.addedCount ?? input.tabs.length,
          input.removedCount ?? 0
        )
      this.insertTabs(input.tabs.map((t) => ({ ...t, sessionId: sid, collectionId: input.collectionId ?? null, createdAt })))
    })()
    return sid
  }

  insertTabs(tabs: (NewTabInput & { sessionId: string | null; collectionId: string | null; createdAt?: string; id?: string } & Partial<TabItem>)[]): void {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO tabs
      (id, session_id, collection_id, title, url, norm_url, domain, favicon, created_at, group_name, description, keywords, link_status, link_code, link_note, last_checked_at, browser_id, profile_id, pinned, last_active_at)
      VALUES (@id, @sessionId, @collectionId, @title, @url, @normUrl, @domain, @favicon, @createdAt, @groupName, @description, @keywords, @linkStatus, @linkStatusCode, @linkStatusNote, @lastCheckedAt, @browserId, @profileId, @pinned, @lastActiveAt)`)
    const now = new Date().toISOString()
    this.db.transaction(() => {
      for (const t of tabs) {
        ins.run({
          id: t.id ?? randomUUID(),
          sessionId: t.sessionId,
          collectionId: t.collectionId,
          title: t.title || extractDomain(t.url),
          url: t.url,
          normUrl: normalizeUrl(t.url),
          domain: extractDomain(t.url),
          favicon: t.favicon ?? faviconFor(t.url),
          createdAt: t.createdAt ?? now,
          groupName: t.groupName ?? null,
          description: t.description ?? '',
          keywords: JSON.stringify(t.keywords ?? []),
          linkStatus: t.linkStatus ?? 'unknown',
          linkStatusCode: t.linkStatusCode ?? null,
          linkStatusNote: t.linkStatusNote ?? null,
          lastCheckedAt: t.lastCheckedAt ?? null,
          browserId: t.browserId ?? null,
          profileId: t.profileId ?? null,
          pinned: t.pinned ? 1 : 0,
          lastActiveAt: t.lastActiveAt ?? null
        })
      }
    })()
  }

  updateSession(p: { id: string; name?: string; note?: string; tags?: string[]; groupNames?: Record<string, string> }): void {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(p.id) as Row | undefined
    if (!s) throw new Error('会话不存在')
    const cur = toSession(s)
    this.db
      .prepare('UPDATE sessions SET name = ?, note = ?, tags = ?, group_names = ? WHERE id = ?')
      .run(p.name ?? cur.name, p.note ?? cur.note, JSON.stringify(p.tags ?? cur.tags), JSON.stringify(p.groupNames ?? cur.groupNames), p.id)
  }

  /** Deletes a session; organized tabs survive in their collection, unsorted ones are removed. */
  deleteSession(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM tabs WHERE session_id = ? AND collection_id IS NULL AND id NOT IN (SELECT tab_id FROM snapshot_items WHERE session_id <> ?)')
        .run(id, id)
      this.db.prepare('UPDATE tabs SET session_id = (SELECT session_id FROM snapshot_items WHERE tab_id = tabs.id LIMIT 1) WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    })()
  }

  /** Get (or create) the daily snapshot session for a local day. */
  dailySession(day = localDay()): string {
    const r = this.db.prepare("SELECT id FROM sessions WHERE kind = 'daily' AND day = ?").get(day) as Row | undefined
    if (r) return r.id as string
    const id = randomUUID()
    const [y, m, d] = day.split('-').map(Number)
    this.db
      .prepare("INSERT INTO sessions (id, name, created_at, note, tags, kind, day) VALUES (?, ?, ?, '', '[]', 'daily', ?)")
      .run(id, dayTitle(day), new Date(y, m - 1, d, 0, 0, 1).toISOString(), day)
    return id
  }

  /**
   * Merge one capture into today's snapshot. Dedup by normalized URL: an existing library tab (inbox or
   * organized) is re-used and stays linked to its folder; the day's item keeps latest title, first/last
   * seen, a seen counter and the set of browser profiles it came from.
   */
  recordCapture(tabs: CaptureTab[], at = new Date()): CaptureOutcome {
    const day = localDay(at)
    const iso = at.toISOString()
    const findTab = this.db.prepare('SELECT id FROM tabs WHERE norm_url = ? ORDER BY (collection_id IS NULL), created_at LIMIT 1')
    const getItem = this.db.prepare('SELECT * FROM snapshot_items WHERE session_id = ? AND tab_id = ?')
    const insItem = this.db.prepare(
      'INSERT INTO snapshot_items (session_id, tab_id, title, first_seen_at, last_seen_at, seen_count, sources) VALUES (?, ?, ?, ?, ?, 1, ?)'
    )
    const updItem = this.db.prepare(
      'UPDATE snapshot_items SET title = ?, last_seen_at = ?, seen_count = seen_count + 1, sources = ? WHERE session_id = ? AND tab_id = ?'
    )
    const updTab = this.db.prepare("UPDATE tabs SET title = CASE WHEN ? <> '' THEN ? ELSE title END, last_active_at = COALESCE(?, last_active_at) WHERE id = ?")
    let newToday = 0
    let newOverall = 0
    let sid = ''
    this.db.transaction(() => {
      sid = this.dailySession(day)
      const seen = new Map<string, CaptureTab[]>()
      for (const t of tabs) {
        if (!/^https?:\/\//i.test(t.url)) continue
        const k = normalizeUrl(t.url)
        const arr = seen.get(k)
        if (arr) arr.push(t)
        else seen.set(k, [t])
      }
      for (const [k, group] of seen) {
        const t = group[group.length - 1]
        const sources = [...new Set(group.map((g) => g.source).filter(Boolean))]
        let tabId = (findTab.get(k) as Row | undefined)?.id as string | undefined
        if (!tabId) {
          tabId = randomUUID()
          this.insertTabs([{ ...t, id: tabId, sessionId: sid, collectionId: null, createdAt: iso }])
          newOverall++
        } else {
          updTab.run(t.title ?? '', t.title ?? '', t.lastActiveAt ?? null, tabId)
        }
        const item = getItem.get(sid, tabId) as Row | undefined
        if (item) {
          const merged = [...new Set([...(JSON.parse(item.sources as string) as string[]), ...sources])]
          updItem.run(t.title || (item.title as string), iso, JSON.stringify(merged), sid, tabId)
        } else {
          insItem.run(sid, tabId, t.title || '', iso, iso, JSON.stringify(sources))
          newToday++
        }
      }
    })()
    const dayTotal = (this.db.prepare('SELECT COUNT(*) c FROM snapshot_items WHERE session_id = ?').get(sid) as Row).c as number
    return { sessionId: sid, day, captured: tabs.length, newToday, newOverall, dayTotal }
  }

  items(): SnapshotItem[] {
    return (this.db.prepare('SELECT * FROM snapshot_items').all() as Row[]).map((r) => ({
      sessionId: r.session_id as string,
      tabId: r.tab_id as string,
      title: r.title as string,
      firstSeenAt: r.first_seen_at as string,
      lastSeenAt: r.last_seen_at as string,
      seenCount: r.seen_count as number,
      sources: JSON.parse(r.sources as string) as string[]
    }))
  }

  /** Per-day counts: total items and how many were not in the previous day's snapshot. */
  dayStats(): Map<string, { total: number; newVsPrev: number }> {
    const days = this.db.prepare("SELECT id, day FROM sessions WHERE kind = 'daily' ORDER BY day").all() as Row[]
    const setOf = this.db.prepare('SELECT tab_id FROM snapshot_items WHERE session_id = ?')
    const out = new Map<string, { total: number; newVsPrev: number }>()
    let prev = new Set<string>()
    for (const d of days) {
      const cur = new Set((setOf.all(d.id) as Row[]).map((r) => r.tab_id as string))
      let n = 0
      for (const t of cur) if (!prev.has(t)) n++
      out.set(d.id as string, { total: cur.size, newVsPrev: n })
      prev = cur
    }
    return out
  }

  annotateDaily(sessionId: string, trigger: string, openCount: number, dayTotal: number): void {
    const row = this.db.prepare('SELECT source_summary FROM sessions WHERE id = ?').get(sessionId) as Row | undefined
    const kinds = new Set(((row?.source_summary as string) || '').split(',').filter(Boolean))
    kinds.add(trigger)
    const vsPrev = this.dayStats().get(sessionId)?.newVsPrev ?? 0
    this.db
      .prepare('UPDATE sessions SET source_summary = ?, note = ? WHERE id = ?')
      .run([...kinds].join(','), `今日快照 · 当前打开 ${openCount} · 今日收录 ${dayTotal} · 较昨日新增 ${vsPrev}`, sessionId)
  }

  // ---- tabs ----
  private updateMany(sql: string, tabIds: string[], ...lead: unknown[]): number {
    let n = 0
    this.db.transaction(() => {
      for (const part of chunk(tabIds)) {
        n += this.db.prepare(`${sql} WHERE id IN (${part.map(() => '?').join(',')})`).run(...lead, ...part).changes
      }
    })()
    return n
  }

  setGroup(tabIds: string[], groupName: string | null): number {
    return this.updateMany('UPDATE tabs SET group_name = ?', tabIds, groupName)
  }

  moveToCollection(tabIds: string[], collectionId: string | null): number {
    if (collectionId && !this.db.prepare('SELECT 1 FROM collections WHERE id = ?').get(collectionId)) throw new Error('收藏夹不存在')
    return this.updateMany('UPDATE tabs SET collection_id = ?, organized_at = ?', tabIds, collectionId, collectionId ? new Date().toISOString() : null)
  }

  /** Move tabs to the recycle bin (row JSON kept so it can be restored exactly). */
  trashTabs(tabIds: string[]): number {
    const now = new Date().toISOString()
    const get = this.db.prepare('SELECT * FROM tabs WHERE id = ?')
    const put = this.db.prepare('INSERT OR REPLACE INTO trash (id, data, deleted_at) VALUES (?, ?, ?)')
    let n = 0
    this.db.transaction(() => {
      for (const id of tabIds) {
        const row = get.get(id) as Row | undefined
        if (!row) continue
        put.run(id, JSON.stringify(row), now)
        n++
      }
      this.deleteTabs(tabIds)
    })()
    return n
  }

  trashList(): (TabItem & { deletedAt: string })[] {
    return (this.db.prepare('SELECT * FROM trash ORDER BY deleted_at DESC').all() as Row[]).map((r) => ({
      ...toTab(JSON.parse(r.data as string) as Row),
      deletedAt: r.deleted_at as string
    }))
  }

  restoreFromTrash(ids: string[]): number {
    let n = 0
    const get = this.db.prepare('SELECT data FROM trash WHERE id = ?')
    const del = this.db.prepare('DELETE FROM trash WHERE id = ?')
    const hasSession = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?')
    const hasCol = this.db.prepare('SELECT 1 FROM collections WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) {
        const r = get.get(id) as Row | undefined
        if (!r) continue
        const row = JSON.parse(r.data as string) as Row
        if (row.session_id && !hasSession.get(row.session_id)) row.session_id = null
        if (row.collection_id && !hasCol.get(row.collection_id)) row.collection_id = null
        const cols = Object.keys(row)
        this.db.prepare(`INSERT OR IGNORE INTO tabs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]))
        del.run(id)
        n++
      }
    })()
    return n
  }

  emptyTrash(ids?: string[]): number {
    if (!ids) return this.db.prepare('DELETE FROM trash').run().changes
    let n = 0
    for (const part of chunk(ids)) n += this.db.prepare(`DELETE FROM trash WHERE id IN (${part.map(() => '?').join(',')})`).run(...part).changes
    return n
  }

  updateTab(id: string, patch: { note?: string; title?: string }): void {
    if (patch.note !== undefined) this.db.prepare('UPDATE tabs SET note = ? WHERE id = ?').run(patch.note, id)
    if (patch.title !== undefined) this.db.prepare('UPDATE tabs SET title = ? WHERE id = ?').run(patch.title, id)
  }

  deleteTabs(tabIds: string[]): number {
    let n = 0
    this.db.transaction(() => {
      for (const part of chunk(tabIds)) n += this.db.prepare(`DELETE FROM tabs WHERE id IN (${part.map(() => '?').join(',')})`).run(...part).changes
    })()
    return n
  }

  setLinkStatus(tabId: string, r: { status: LinkStatus; statusCode?: number | null; note?: string | null; checkedAt: string }): void {
    this.db
      .prepare('UPDATE tabs SET link_status = ?, link_code = ?, link_note = ?, last_checked_at = ? WHERE id = ?')
      .run(r.status, r.statusCode ?? null, r.note ?? null, r.checkedAt, tabId)
  }

  setSummary(tabId: string, description: string, keywords: string[]): void {
    this.db.prepare('UPDATE tabs SET description = ?, keywords = ? WHERE id = ?').run(description, JSON.stringify(keywords), tabId)
  }

  /** Persist AI enrichment; remembers title+url so a later change triggers re-enrichment. */
  setEnrichment(tabId: string, e: { description: string; keywords: string[]; topics: string[]; summary: string; lang: string }, by: 'local' | 'cloud'): void {
    this.db
      .prepare(
        'UPDATE tabs SET description = ?, keywords = ?, topics = ?, summary = ?, lang = ?, enriched_at = ?, enriched_by = ?, enriched_sig = title || char(10) || url, enrich_v = ? WHERE id = ?'
      )
      .run(e.description, JSON.stringify(e.keywords), JSON.stringify(e.topics), e.summary, e.lang, new Date().toISOString(), by, ENRICH_VERSION, tabId)
  }

  /** Tabs/bookmarks never enriched, or whose title/url changed since (oldest first). */
  needEnrichment(limit = 20): TabItem[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM tabs WHERE enriched_at IS NULL OR enriched_sig IS NOT (title || char(10) || url) OR enrich_v < ? ORDER BY (enriched_at IS NOT NULL), (enrich_v >= ?), created_at DESC LIMIT ?'
        )
        .all(ENRICH_VERSION, ENRICH_VERSION, limit) as Row[]
    ).map(toTab)
  }

  enrichmentStats(): { total: number; enriched: number; cloud: number; pending: number; fetched: number } {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) total, SUM(enriched_at IS NOT NULL) enriched, SUM(enriched_by = 'cloud') cloud, SUM(enriched_at IS NULL OR enriched_sig IS NOT (title || char(10) || url) OR enrich_v < ?) pending, (SELECT COUNT(*) FROM tab_ai WHERE fetch_status = 'ok') fetched FROM tabs"
      )
      .get(ENRICH_VERSION) as Row
    return {
      total: Number(r.total) || 0,
      enriched: Number(r.enriched) || 0,
      cloud: Number(r.cloud) || 0,
      pending: Number(r.pending) || 0,
      fetched: Number(r.fetched) || 0
    }
  }

  /**
   * "AI 搜索": split a natural-language query into terms, OR them over FTS (title/url/AI description/keywords/topics/summary),
   * rank by bm25 with AI fields weighted, and report which fields matched.
   */
  aiSearch(q: string, limit = 200): { tab: TabItem; score: number; matched: string[] }[] {
    const terms = [
      ...new Set(
        q
          .toLowerCase()
          .split(/[\s,，。.;；、?？!！"'“”]+|的|和|与|关于|有关|一些|那个|这个/)
          .map((x) => x.trim())
          .filter(Boolean)
      )
    ].slice(0, 12)
    if (!terms.length) return []
    const score = new Map<string, { tab: TabItem; score: number; matched: Set<string> }>()
    const fields = ['title', 'url', 'description', 'keywords', 'topics', 'summary'] as const
    const label: Record<string, string> = { title: '标题', url: '网址', description: '描述', keywords: '关键词', topics: '主题', summary: '摘要' }
    for (const term of terms) {
      let rows: Row[]
      if ([...term].length >= 3) {
        rows = this.db
          .prepare(
            'SELECT t.*, bm25(tabs_fts, 0, 1.0, 0.5, 1.5, 2.0, 2.0, 1.5) AS rk FROM tabs_fts f JOIN tabs t ON t.id = f.tab_id WHERE tabs_fts MATCH ? ORDER BY rk LIMIT ?'
          )
          .all('"' + term.replace(/"/g, '""') + '"', limit * 2) as Row[]
      } else {
        const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`
        rows = this.db
          .prepare(
            "SELECT *, -1.0 AS rk FROM tabs WHERE title LIKE @l ESCAPE '\\' OR url LIKE @l ESCAPE '\\' OR description LIKE @l ESCAPE '\\' OR keywords LIKE @l ESCAPE '\\' OR topics LIKE @l ESCAPE '\\' OR summary LIKE @l ESCAPE '\\' LIMIT @n"
          )
          .all({ l: like, n: limit * 2 }) as Row[]
      }
      for (const r of rows) {
        const id = r.id as string
        const cur = score.get(id) ?? { tab: toTab(r), score: 0, matched: new Set<string>() }
        cur.score += 1 + Math.min(5, Math.abs(Number(r.rk) || 0))
        for (const f of fields)
          if (
            String(r[f] ?? '')
              .toLowerCase()
              .includes(term)
          )
            cur.matched.add(label[f])
        score.set(id, cur)
      }
    }
    return [...score.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => ({ tab: x.tab, score: Math.round(x.score * 100) / 100, matched: [...x.matched] }))
  }

  // ---- collections ----
  createCollection(name: string, note = '', parentId: string | null = null): string {
    if (parentId && !this.db.prepare('SELECT 1 FROM collections WHERE id = ?').get(parentId)) throw new Error('上级收藏夹不存在')
    const cid = randomUUID()
    const sort = ((this.db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM collections WHERE parent_id IS ?').get(parentId) as Row).m as number) + 1
    this.db
      .prepare('INSERT INTO collections (id, name, created_at, note, builtin, parent_id, sort) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(cid, name, new Date().toISOString(), note, parentId, sort)
    return cid
  }

  moveCollection(id: string, parentId: string | null): void {
    if (parentId === id) throw new Error('不能移动到自身')
    // Prevent cycles: parent must not be inside id's subtree.
    if (parentId && this.descendants(id).includes(parentId)) throw new Error('不能移动到自己的子文件夹')
    this.db.prepare('UPDATE collections SET parent_id = ? WHERE id = ? AND builtin = 0').run(parentId, id)
  }

  descendants(id: string): string[] {
    const rows = this.db
      .prepare(
        'WITH RECURSIVE sub(id) AS (SELECT id FROM collections WHERE parent_id = ? UNION ALL SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id) SELECT id FROM sub'
      )
      .all(id) as Row[]
    return rows.map((r) => r.id as string)
  }

  /** Recursively import a bookmark tree (nested folders preserved). Skips URLs already in the same folder. */
  importBookmarkTree(nodes: BookmarkInput[], parentId: string | null, sessionId: string | null = null): number {
    let n = 0
    const exists = this.db.prepare('SELECT 1 FROM tabs WHERE collection_id IS ? AND norm_url = ?')
    this.db.transaction(() => {
      const walk = (items: BookmarkInput[], parent: string | null) => {
        for (const item of items) {
          if (item.url) {
            if (!/^https?:\/\//i.test(item.url) || exists.get(parent, normalizeUrl(item.url))) continue
            const id = randomUUID()
            this.insertTabs([{ id, title: item.title, url: item.url, sessionId, collectionId: parent, createdAt: item.addedAt }])
            this.db.prepare("UPDATE tabs SET placed_by = 'import' WHERE id = ?").run(id)
            n++
          } else if (item.children) {
            const found = this.db.prepare('SELECT id FROM collections WHERE name = ? AND parent_id IS ?').get(item.title, parent) as Row | undefined
            walk(item.children, found ? (found.id as string) : this.createCollection(item.title, '', parent))
          }
        }
      }
      walk(nodes, parentId)
    })()
    return n
  }

  stats(): { totalTabs: number; inbox: number; organizedWeek: number; capturedToday: number; collections: number } {
    const week = new Date(Date.now() - 7 * 86400000).toISOString()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const one = (sql: string, ...a: unknown[]) => (this.db.prepare(sql).get(...a) as Row).c as number
    return {
      totalTabs: one('SELECT COUNT(*) c FROM tabs'),
      inbox: one('SELECT COUNT(*) c FROM tabs WHERE collection_id IS NULL'),
      organizedWeek: one('SELECT COUNT(*) c FROM tabs WHERE collection_id IS NOT NULL AND organized_at >= ?', week),
      capturedToday: one('SELECT COALESCE(SUM(added_count), 0) c FROM sessions WHERE created_at >= ?', today.toISOString()),
      collections: one('SELECT COUNT(*) c FROM collections')
    }
  }

  // ---- auto-organize activity log (every automatic change is undoable) ----
  logOrg(kind: string, summary: string, data: UndoData, engine = 'local'): string {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO org_log (id, at, kind, summary, data, engine) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, new Date().toISOString(), kind, summary, JSON.stringify(data), engine)
    return id
  }

  orgLog(limit = 200): OrgLogEntry[] {
    return (this.db.prepare('SELECT * FROM org_log ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id as string,
      at: r.at as string,
      kind: r.kind as string,
      summary: r.summary as string,
      engine: r.engine as string,
      undone: !!r.undone,
      data: JSON.parse(r.data as string) as UndoData
    }))
  }

  /** Move tabs and return where each one was before (for undo). */
  moveWithHistory(tabIds: string[], collectionId: string | null): { tabId: string; from: string | null; placedBy?: string | null }[] {
    const get = this.db.prepare('SELECT collection_id c, placed_by p FROM tabs WHERE id = ?')
    const moves = tabIds.map((id) => {
      const r = get.get(id) as Row | undefined
      return { tabId: id, from: (r?.c as string) ?? null, placedBy: (r?.p as string) ?? null }
    })
    this.moveToCollection(tabIds, collectionId)
    this.setPlacedBy(tabIds, collectionId ? 'ai' : null)
    return moves
  }

  setPlacedBy(tabIds: string[], by: 'import' | 'ai' | 'user' | null): number {
    return this.updateMany('UPDATE tabs SET placed_by = ?', tabIds, by)
  }

  /** Bookmarks imported from browsers that AI has not re-sorted yet (still in their original folder structure). */
  importedBookmarkIds(): string[] {
    return (this.db.prepare("SELECT id FROM tabs WHERE placed_by = 'import' AND collection_id IS NOT NULL").all() as Row[]).map((r) => r.id as string)
  }

  placedBy(id: string): string | null {
    return ((this.db.prepare('SELECT placed_by p FROM tabs WHERE id = ?').get(id) as Row | undefined)?.p as string) ?? null
  }

  /** Revert one log entry: restore deleted folders, move tabs back, undo renames, drop created (now empty) folders. */
  undoOrg(id: string): boolean {
    const r = this.db.prepare('SELECT data, undone FROM org_log WHERE id = ?').get(id) as Row | undefined
    if (!r || r.undone) return false
    const d = JSON.parse(r.data as string) as UndoData
    this.db.transaction(() => {
      for (const c of d.deleted ?? [])
        if (!this.db.prepare('SELECT 1 FROM collections WHERE id = ?').get(c.id))
          this.db
            .prepare('INSERT INTO collections (id, name, created_at, note, builtin, parent_id, sort) VALUES (?, ?, ?, ?, 0, ?, 0)')
            .run(
              c.id,
              c.name,
              new Date().toISOString(),
              c.note,
              c.parentId && this.db.prepare('SELECT 1 FROM collections WHERE id = ?').get(c.parentId) ? c.parentId : null
            )
      const upd = this.db.prepare('UPDATE tabs SET collection_id = ?, organized_at = ? WHERE id = ?')
      const pb = this.db.prepare('UPDATE tabs SET placed_by = ? WHERE id = ?')
      const exists = this.db.prepare('SELECT 1 FROM collections WHERE id = ?')
      for (const m of [...(d.moves ?? [])].reverse()) {
        const back = m.from && exists.get(m.from) ? m.from : null
        upd.run(back, back ? new Date().toISOString() : null, m.tabId)
        if ('placedBy' in m) pb.run(back ? (m.placedBy ?? null) : null, m.tabId)
      }
      for (const x of d.renamed ?? []) this.db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(x.from, x.id)
      if (d.trashed?.length) this.restoreFromTrash(d.trashed)
      for (const k of d.kept ?? [])
        this.db
          .prepare('UPDATE tabs SET collection_id = ?, description = ?, keywords = ?, note = ? WHERE id = ?')
          .run(k.collectionId && exists.get(k.collectionId) ? k.collectionId : null, k.description, JSON.stringify(k.keywords), k.note, k.tabId)
      const clr = this.db.prepare('UPDATE tabs SET org_reason = NULL WHERE id = ?')
      for (const m of d.moves ?? []) clr.run(m.tabId)
      for (const cid of [...(d.created ?? [])].reverse()) {
        const busy = this.db.prepare('SELECT 1 FROM tabs WHERE collection_id = ? UNION SELECT 1 FROM collections WHERE parent_id = ?').get(cid, cid)
        if (!busy) this.db.prepare('DELETE FROM collections WHERE id = ? AND builtin = 0').run(cid)
      }
      this.db.prepare('UPDATE org_log SET undone = 1 WHERE id = ?').run(id)
    })()
    return true
  }

  collectionRow(id: string): { id: string; name: string; parentId: string | null; note: string } | null {
    const r = this.db.prepare('SELECT id, name, parent_id, note FROM collections WHERE id = ?').get(id) as Row | undefined
    return r ? { id: r.id as string, name: r.name as string, parentId: (r.parent_id as string) ?? null, note: r.note as string } : null
  }

  /** Items per source browser in a day's daily snapshot. */
  dayCountByBrowser(day = localDay()): Record<string, number> {
    const s = this.db.prepare("SELECT id FROM sessions WHERE kind = 'daily' AND day = ?").get(day) as Row | undefined
    if (!s) return {}
    // Count by every source that saw the item (a URL open in Edge AND Opera counts for both).
    const out: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT sources FROM snapshot_items WHERE session_id = ?').all(s.id) as Row[]) {
      let src: string[] = []
      try {
        src = JSON.parse(r.sources as string) as string[]
      } catch {
        /* ignore */
      }
      for (const b of new Set(src.map((x) => x.split('::')[0]).filter(Boolean))) out[b] = (out[b] ?? 0) + 1
    }
    return out
  }

  /** Wipe every user record (used to clear leftovers from old versions). Settings/token are kept. */
  clearAllData(): void {
    this.db.transaction(() => {
      for (const t of ['snapshot_items', 'trash', 'org_log', 'tabs', 'sessions']) this.db.prepare(`DELETE FROM ${t}`).run()
      this.db.prepare('DELETE FROM collections WHERE builtin = 0').run()
      this.db.prepare("DELETE FROM settings WHERE key IN ('lastOpenSet', 'lastCaptureAt')").run()
    })()
  }

  /** Unsorted tabs not active for `days` (based on the browser's last-active time, else capture time). */
  staleTabs(days = 7): TabItem[] {
    const cut = new Date(Date.now() - days * 86400000).toISOString()
    return (
      this.db
        .prepare('SELECT * FROM tabs WHERE collection_id IS NULL AND COALESCE(last_active_at, created_at) < ? ORDER BY COALESCE(last_active_at, created_at)')
        .all(cut) as Row[]
    ).map(toTab)
  }

  /** Normalized URLs of every tab TabNest already knows (for "what's new" diffs and recovery). */
  knownNormUrls(): Set<string> {
    return new Set((this.db.prepare('SELECT norm_url FROM tabs').all() as Row[]).map((r) => r.norm_url as string))
  }

  /** Mark tabs still open in the browser as recently seen. */
  touchSeen(normUrls: string[], at: string): void {
    const st = this.db.prepare('UPDATE tabs SET last_active_at = ? WHERE norm_url = ? AND collection_id IS NULL')
    this.db.transaction(() => {
      for (const u of normUrls) st.run(at, u)
    })()
  }

  findCollectionByName(name: string): Collection | null {
    const r = this.db.prepare('SELECT * FROM collections WHERE name = ?').get(name) as Row | undefined
    return r ? toCollection(r) : null
  }

  updateCollection(p: { id: string; name?: string; note?: string }): void {
    const r = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(p.id) as Row | undefined
    if (!r) throw new Error('收藏夹不存在')
    this.db.prepare('UPDATE collections SET name = ?, note = ? WHERE id = ?').run(p.name ?? r.name, p.note ?? r.note, p.id)
  }

  /** Items go back to 未整理 (tabs with a session) or are dropped (orphans). */
  clearCollection(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM tabs WHERE collection_id = ? AND session_id IS NULL').run(id)
      this.db.prepare('UPDATE tabs SET collection_id = NULL WHERE collection_id = ?').run(id)
    })()
  }

  /** Deletes a folder and its sub-folders; tabs from sessions go back to 未整理, orphans are removed. */
  deleteCollection(id: string): void {
    const r = this.db.prepare('SELECT builtin FROM collections WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new Error('收藏夹不存在')
    if (r.builtin) throw new Error('内置收藏夹不能删除，可以清空')
    const all = [...this.descendants(id).reverse(), id]
    this.db.transaction(() => {
      for (const c of all) {
        this.clearCollection(c)
        this.db.prepare('DELETE FROM collections WHERE id = ?').run(c)
      }
    })()
  }

  // ---- search ----
  /** FTS5 trigram search (substring, CJK friendly); queries < 3 chars fall back to LIKE. */
  search(q: string, limit = 500): TabItem[] {
    const term = q.trim()
    if (!term) return []
    if ([...term].length >= 3) {
      const fts = '"' + term.replace(/"/g, '""') + '"'
      const rows = this.db
        .prepare('SELECT t.* FROM tabs_fts f JOIN tabs t ON t.id = f.tab_id WHERE tabs_fts MATCH ? ORDER BY bm25(tabs_fts) LIMIT ?')
        .all(fts, limit) as Row[]
      return rows.map(toTab)
    }
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`
    const rows = this.db
      .prepare(
        "SELECT * FROM tabs WHERE title LIKE @l ESCAPE '\\' OR url LIKE @l ESCAPE '\\' OR domain LIKE @l ESCAPE '\\' OR description LIKE @l ESCAPE '\\' OR keywords LIKE @l ESCAPE '\\' LIMIT @n"
      )
      .all({ l: like, n: limit }) as Row[]
    return rows.map(toTab)
  }

  // ---- duplicates ----
  findDuplicates(): DuplicateGroup[] {
    const keys = this.db.prepare('SELECT norm_url FROM tabs GROUP BY norm_url HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC').all() as Row[]
    const stmt = this.db.prepare('SELECT * FROM tabs WHERE norm_url = ? ORDER BY (collection_id IS NULL), created_at')
    return keys.map((k) => ({ normUrl: k.norm_url as string, tabs: (stmt.all(k.norm_url) as Row[]).map(toTab) }))
  }

  /**
   * Keep one item; it absorbs the others' folder / description / keywords / note, the others go to the recycle bin.
   * Returns undo data (recorded by the caller in the 智能整理 log). `sameUrlOnly` keeps the 1.3 behaviour.
   */
  mergeDuplicates(keepId: string, removeIds: string[], sameUrlOnly = true): UndoData {
    const [keep] = this.getTabs([keepId])
    if (!keep) throw new Error('保留项不存在')
    const others = this.getTabs(removeIds.filter((x) => x !== keepId))
    if (sameUrlOnly && others.some((o) => o.normUrl !== keep.normUrl)) throw new Error('只能合并相同链接')
    const collectionId = keep.collectionId ?? others.find((o) => o.collectionId)?.collectionId ?? null
    const description = keep.description || others.find((o) => o.description)?.description || ''
    const keywords = [...new Set([...keep.keywords, ...others.flatMap((o) => o.keywords)])].slice(0, 12)
    const note = [keep.note, ...others.map((o) => o.note)].filter(Boolean).join('\n').slice(0, 10000)
    const data: UndoData = {
      trashed: others.map((o) => o.id),
      kept: [{ tabId: keep.id, collectionId: keep.collectionId, description: keep.description, keywords: keep.keywords, note: keep.note ?? '' }]
    }
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE tabs SET collection_id = ?, description = ?, keywords = ?, note = ? WHERE id = ?')
        .run(collectionId, description, JSON.stringify(keywords), note, keepId)
      this.trashTabs(others.map((o) => o.id))
    })()
    return data
  }

  setOrgReason(tabIds: string[], reason: string | null): void {
    const st = this.db.prepare('UPDATE tabs SET org_reason = ? WHERE id = ?')
    this.db.transaction(() => tabIds.forEach((id) => st.run(reason ? reason.slice(0, 300) : null, id)))()
  }

  // ---- backup / restore ----
  exportAll(): { app: 'TabNest'; schema: number; exportedAt: string } & Snapshot {
    return { app: 'TabNest', schema: this.schemaVersion, exportedAt: new Date().toISOString(), ...this.snapshot() }
  }

  /** Merge a TabNest JSON backup (ids preserved; existing rows are kept). Returns imported tab count. */
  importBackup(data: unknown): number {
    const d = data as Partial<Snapshot> & { app?: string }
    if (!d || !Array.isArray(d.sessions) || !Array.isArray(d.collections) || !Array.isArray(d.tabs)) throw new Error('不是有效的 TabNest 备份文件')
    const before = (this.db.prepare('SELECT COUNT(*) c FROM tabs').get() as Row).c as number
    this.db.transaction(() => {
      const insS = this.db.prepare('INSERT OR IGNORE INTO sessions (id, name, created_at, note, tags, group_names) VALUES (?, ?, ?, ?, ?, ?)')
      for (const s of d.sessions!) insS.run(s.id, s.name, s.createdAt, s.note ?? '', JSON.stringify(s.tags ?? []), JSON.stringify(s.groupNames ?? {}))
      const idMap = new Map<string, string>()
      for (const c of d.collections!) {
        const byName = this.findCollectionByName(c.name)
        if (byName) idMap.set(c.id, byName.id)
        else {
          this.db
            .prepare('INSERT OR IGNORE INTO collections (id, name, created_at, note, builtin, sort) VALUES (?, ?, ?, ?, 0, ?)')
            .run(c.id, c.name, c.createdAt, c.note ?? '', c.sort ?? 0)
          idMap.set(c.id, c.id)
        }
      }
      const sessionIds = new Set((this.db.prepare('SELECT id FROM sessions').all() as Row[]).map((r) => r.id as string))
      this.insertTabs(
        d
          .tabs!.filter((t) => t && typeof t.url === 'string')
          .map((t) => ({
            ...t,
            sessionId: t.sessionId && sessionIds.has(t.sessionId) ? t.sessionId : null,
            collectionId: t.collectionId ? (idMap.get(t.collectionId) ?? null) : null
          }))
      )
    })()
    return ((this.db.prepare('SELECT COUNT(*) c FROM tabs').get() as Row).c as number) - before
  }

  /** One-time import of the pre-1.0 JSON store (sessions with embedded tabs + collection copies). */
  importLegacyJson(data: unknown): number {
    const d = data as {
      sessions?: {
        name: string
        createdAt: string
        note?: string
        tags?: string[]
        tabs?: (Partial<TabItem> & { url: string; title: string; organized?: boolean })[]
      }[]
      collections?: { id: string; name: string; note?: string; tabs?: { url: string; title: string }[] }[]
    }
    if (!d || !Array.isArray(d.sessions)) throw new Error('旧数据格式无效')
    let count = 0
    this.db.transaction(() => {
      const colMap = new Map<string, string>()
      for (const c of d.collections ?? []) colMap.set(c.id, this.findCollectionByName(c.name)?.id ?? this.createCollection(c.name, c.note ?? ''))
      const placed = new Set<string>()
      for (const s of d.sessions!) {
        const tabs = (s.tabs ?? []).filter((t) => t?.url)
        const sid = this.createSession({ name: s.name, note: s.note, tags: s.tags, createdAt: s.createdAt, tabs: [] })
        this.insertTabs(
          tabs.map((t) => {
            const cid = t.collectionId ? (colMap.get(t.collectionId) ?? null) : null
            if (cid) placed.add(cid + '|' + t.url)
            return {
              title: t.title,
              url: t.url,
              sessionId: sid,
              collectionId: cid,
              createdAt: t.createdAt,
              groupName: t.groupName ?? null,
              description: t.description,
              keywords: t.keywords
            }
          })
        )
        count += tabs.length
      }
      for (const c of d.collections ?? []) {
        const cid = colMap.get(c.id)!
        const orphans = (c.tabs ?? []).filter((t) => t?.url && !placed.has(cid + '|' + t.url))
        this.insertTabs(orphans.map((t) => ({ title: t.title, url: t.url, sessionId: null, collectionId: cid })))
        count += orphans.length
      }
    })()
    return count
  }
}
