import type Database from 'better-sqlite3'
import { centroid, embedLocal, cosine, fromBlob, toBlob } from '../../shared/ai/vector'
import { parseNlQuery, type NlQuery } from '../../shared/ai/nlquery'
import { findNearDuplicates, type DupGroup } from '../../shared/ai/dedupe'
import { siteOf } from '../../shared/cluster'
import type { Exemplar } from '../../shared/autoorg/engine'

type Row = Record<string, unknown>

interface IndexDoc {
  id: string
  title: string
  url: string
  domain: string
  /** lowercase field texts for lexical matching */
  f: { title: string; url: string; description: string; keywords: string; topics: string; summary: string; content: string }
  vec: Float32Array
  emb: Float32Array | null
  createdAt: string
}

export interface SmartHit {
  id: string
  score: number
  matched: string[]
}
export interface SmartResult {
  items: SmartHit[]
  chips: NlQuery['chips']
  terms: string[]
  question: boolean
  ms: number
  total: number
}

const FIELD_W: Record<keyof IndexDoc['f'], number> = { title: 3, keywords: 2.4, topics: 2, summary: 1.4, description: 1.4, url: 1, content: 0.8 }
const FIELD_LABEL: Record<keyof IndexDoc['f'], string> = {
  title: '标题',
  url: '网址',
  description: '描述',
  keywords: '关键词',
  topics: '主题',
  summary: '摘要',
  content: '正文'
}

/** AI side data (page text, vectors, cache) + natural-language hybrid search over the library. */
export class AiStore {
  private index: Map<string, IndexDoc> | null = null
  private sig = ''

  constructor(private db: Database.Database) {}

  setAiData(
    tabId: string,
    d: {
      content?: string
      contentHash?: string | null
      fetchStatus?: string | null
      vec?: Float32Array | null
      emb?: Float32Array | null
      embModel?: string | null
      points?: string[]
      summarySrc?: string | null
      engine?: string | null
    }
  ): void {
    const cur = this.db.prepare('SELECT * FROM tab_ai WHERE tab_id = ?').get(tabId) as Row | undefined
    const v = {
      content: d.content ?? (cur?.content as string) ?? '',
      hash: d.contentHash !== undefined ? d.contentHash : ((cur?.content_hash as string) ?? null),
      status: d.fetchStatus !== undefined ? d.fetchStatus : ((cur?.fetch_status as string) ?? null),
      fetched: d.fetchStatus !== undefined ? new Date().toISOString() : ((cur?.fetched_at as string) ?? null),
      vec: d.vec ? toBlob(d.vec) : ((cur?.vec as Buffer) ?? null),
      emb: d.emb !== undefined ? (d.emb ? toBlob(d.emb) : null) : ((cur?.emb as Buffer) ?? null),
      embModel: d.embModel !== undefined ? d.embModel : ((cur?.emb_model as string) ?? null)
    }
    if (!this.db.prepare('SELECT 1 FROM tabs WHERE id = ?').get(tabId)) return
    this.db
      .prepare(
        `INSERT INTO tab_ai (tab_id, content, content_hash, fetched_at, fetch_status, vec, emb, emb_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tab_id) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash, fetched_at = excluded.fetched_at,
           fetch_status = excluded.fetch_status, vec = excluded.vec, emb = excluded.emb, emb_model = excluded.emb_model`
      )
      .run(tabId, v.content, v.hash, v.fetched, v.status, v.vec, v.emb, v.embModel)
    if (d.points || d.summarySrc !== undefined || d.engine !== undefined)
      this.db
        .prepare(
          'UPDATE tab_ai SET points = COALESCE(?, points), summary_src = COALESCE(?, summary_src), engine = COALESCE(?, engine), summarized_at = ? WHERE tab_id = ?'
        )
        .run(d.points ? JSON.stringify(d.points) : null, d.summarySrc ?? null, d.engine ?? null, new Date().toISOString(), tabId)
    this.index = null
  }

  aiData(tabId: string): {
    content: string
    fetchStatus: string | null
    fetchedAt: string | null
    hasEmb: boolean
    points: string[]
    summarySrc: string | null
    engine: string | null
    summarizedAt: string | null
  } | null {
    const r = this.db
      .prepare('SELECT content, fetch_status, fetched_at, emb IS NOT NULL e, points, summary_src, engine, summarized_at FROM tab_ai WHERE tab_id = ?')
      .get(tabId) as Row | undefined
    if (!r) return null
    let points: string[] = []
    try {
      points = r.points ? (JSON.parse(r.points as string) as string[]) : []
    } catch {
      points = []
    }
    return {
      content: r.content as string,
      fetchStatus: (r.fetch_status as string) ?? null,
      fetchedAt: (r.fetched_at as string) ?? null,
      hasEmb: !!r.e,
      points,
      summarySrc: (r.summary_src as string) ?? null,
      engine: (r.engine as string) ?? null,
      summarizedAt: (r.summarized_at as string) ?? null
    }
  }

  // ---- cache (cloud responses keyed by content hash) ----
  cacheGet<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM ai_cache WHERE key = ?').get(key) as Row | undefined
    try {
      return r ? (JSON.parse(r.value as string) as T) : null
    } catch {
      return null
    }
  }
  cacheSet(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO ai_cache (key, value, at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), new Date().toISOString())
    const n = (this.db.prepare('SELECT COUNT(*) c FROM ai_cache').get() as Row).c as number
    if (n > 20000) this.db.prepare('DELETE FROM ai_cache WHERE key IN (SELECT key FROM ai_cache ORDER BY at LIMIT ?)').run(n - 20000)
  }

  // ---- in-memory search index ----
  private signature(): string {
    const r = this.db.prepare('SELECT COUNT(*) c, MAX(rowid) m, MAX(enriched_at) e, TOTAL(LENGTH(title)) l FROM tabs').get() as Row
    const a = this.db.prepare('SELECT COUNT(*) c, MAX(fetched_at) f FROM tab_ai').get() as Row
    return `${r.c}|${r.m}|${r.e}|${r.l}|${a.c}|${a.f}`
  }

  private ensureIndex(): Map<string, IndexDoc> {
    const sig = this.signature()
    if (this.index && sig === this.sig) return this.index
    const rows = this.db
      .prepare(
        'SELECT t.id, t.title, t.url, t.domain, t.description, t.keywords, t.topics, t.summary, t.created_at, a.content, a.vec, a.emb FROM tabs t LEFT JOIN tab_ai a ON a.tab_id = t.id'
      )
      .all() as Row[]
    const idx = new Map<string, IndexDoc>()
    for (const r of rows) {
      const kws = JSON.parse((r.keywords as string) || '[]') as string[]
      const tps = JSON.parse((r.topics as string) || '[]') as string[]
      const vec = fromBlob(r.vec as Buffer) ?? embedLocal({ title: r.title as string, keywords: kws, topics: tps, site: siteOf(r.domain as string) })
      const doc: IndexDoc = {
        id: r.id as string,
        title: r.title as string,
        url: r.url as string,
        domain: r.domain as string,
        createdAt: r.created_at as string,
        f: {
          title: (r.title as string).toLowerCase(),
          url: (r.url as string).toLowerCase(),
          description: ((r.description as string) || '').toLowerCase(),
          keywords: kws.join(' ').toLowerCase(),
          topics: tps.join(' ').toLowerCase(),
          summary: ((r.summary as string) || '').toLowerCase(),
          content: ((r.content as string) || '').toLowerCase().slice(0, 1500)
        },
        vec,
        emb: fromBlob(r.emb as Buffer)
      }
      idx.set(doc.id, doc)
    }
    this.index = idx
    this.sig = sig
    return idx
  }

  /** Ids allowed by the structured filters (SQL; uses indexes + snapshot history). */
  private filterIds(q: NlQuery): Set<string> | null {
    const where: string[] = []
    const args: unknown[] = []
    if (q.from && q.to) {
      where.push(
        `((t.created_at >= ? AND t.created_at < ?) OR (t.last_active_at >= ? AND t.last_active_at < ?) OR EXISTS (SELECT 1 FROM snapshot_items si WHERE si.tab_id = t.id AND si.last_seen_at >= ? AND si.first_seen_at < ?))`
      )
      args.push(q.from, q.to, q.from, q.to, q.from, q.to)
    }
    if (q.browser) {
      where.push(`(t.browser_id LIKE ? OR EXISTS (SELECT 1 FROM snapshot_items si WHERE si.tab_id = t.id AND si.sources LIKE ?))`)
      args.push(`${q.browser}%`, `%"${q.browser}%`)
    }
    if (q.site) {
      where.push('(t.domain = ? OR t.domain LIKE ?)')
      args.push(q.site, `%.${q.site}`)
    }
    if (q.folder) {
      where.push(
        `t.collection_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id) SELECT id FROM sub)`
      )
      args.push(q.folder)
    }
    if (q.status === 'dead') where.push("t.link_status IN ('broken','timeout')")
    if (q.status === 'unsorted') where.push('t.collection_id IS NULL')
    if (q.status === 'organized') where.push('t.collection_id IS NOT NULL')
    if (q.status === 'pinned') where.push('t.pinned = 1')
    if (q.status === 'noted') where.push("t.note != ''")
    if (!where.length) return null
    return new Set((this.db.prepare(`SELECT t.id FROM tabs t WHERE ${where.join(' AND ')}`).all(...args) as Row[]).map((r) => r.id as string))
  }

  nlContext(): { browsers: { id: string; name: string }[]; folders: { id: string; name: string }[] } {
    const browsers = (this.db.prepare('SELECT DISTINCT browser_id b FROM tabs WHERE browser_id IS NOT NULL').all() as Row[]).map((r) => ({
      id: r.b as string,
      name: r.b as string
    }))
    const folders = (this.db.prepare('SELECT id, name FROM collections').all() as Row[]).map((r) => ({ id: r.id as string, name: r.name as string }))
    return { browsers, folders }
  }

  /**
   * 智能搜索: parse time / browser / site / folder / status out of the query, then rank the remaining terms with
   * FTS5 bm25 (≥3-char terms, trigram) + in-memory field-weighted BM25-style lexical score + vector similarity.
   */
  smartSearch(input: string, opts: { limit?: number; now?: Date; qEmb?: Float32Array | null; rewrite?: string[] } = {}): SmartResult {
    const t0 = performance.now()
    const limit = opts.limit ?? 200
    const q = parseNlQuery(input, { now: opts.now, ...this.nlContext() })
    if (opts.rewrite?.length)
      q.expansions = [...new Set([...q.expansions, ...opts.rewrite.map((x) => x.toLowerCase())])].filter((x) => !q.terms.includes(x)).slice(0, 20)
    const expanded = new Set(q.expansions)
    const allTerms = [...q.terms, ...q.expansions]
    const idx = this.ensureIndex()
    const allowed = this.filterIds(q)
    const pool = allowed ? [...allowed].map((id) => idx.get(id)).filter((d): d is IndexDoc => !!d) : [...idx.values()]
    const done = (items: SmartHit[]): SmartResult => ({
      items,
      chips: q.chips,
      terms: q.terms,
      question: q.question,
      ms: Math.round(performance.now() - t0),
      total: items.length
    })
    if (!q.terms.length) {
      if (!allowed) return done([])
      return done(
        pool
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map((d) => ({ id: d.id, score: 1, matched: q.chips.map((c) => c.label) }))
      )
    }
    // document frequency per term over the whole library (IDF)
    const N = idx.size || 1
    const idf = new Map<string, number>()
    for (const term of allTerms) {
      let n = 0
      for (const d of idx.values())
        if (d.f.title.includes(term) || d.f.keywords.includes(term) || d.f.topics.includes(term) || d.f.description.includes(term)) n++
      idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
    }
    // FTS bm25 for long terms (one OR query), normalized to 0..1
    const bm = new Map<string, number>()
    const long = allTerms.filter((x) => [...x].length >= 3)
    if (long.length) {
      const match = long.map((x) => '"' + x.replace(/"/g, '""') + '"').join(' OR ')
      try {
        const rows = this.db
          .prepare('SELECT tab_id id, bm25(tabs_fts, 0, 3.0, 1.0, 1.5, 2.4, 2.0, 1.4, 0.8) rk FROM tabs_fts WHERE tabs_fts MATCH ? ORDER BY rk LIMIT 1000')
          .all(match) as Row[]
        const best = rows.length ? -(rows[0].rk as number) : 1
        for (const r of rows) bm.set(r.id as string, best > 0 ? -(r.rk as number) / best : 0)
      } catch {
        /* malformed FTS query → lexical only */
      }
    }
    const qv = embedLocal({ title: q.text || q.terms.join(' '), keywords: allTerms })
    const scored: { d: IndexDoc; lex: number; cos: number; ecos: number; m: Set<string> }[] = []
    let maxLex = 0
    for (const d of pool) {
      let lex = 0
      const m = new Set<string>()
      for (const term of allTerms) {
        let best = 0
        let field: keyof IndexDoc['f'] | null = null
        for (const k of Object.keys(FIELD_W) as (keyof IndexDoc['f'])[]) {
          if (FIELD_W[k] > best && d.f[k].includes(term)) {
            best = FIELD_W[k]
            field = k
          }
        }
        if (field) {
          lex += best * (idf.get(term) ?? 1) * Math.min(1.5, 0.5 + [...term].length / 4) * (expanded.has(term) ? 0.6 : 1)
          m.add(FIELD_LABEL[field])
        }
      }
      const cos = Math.max(0, cosine(qv, d.vec))
      const ecos = opts.qEmb && d.emb ? Math.max(0, cosine(opts.qEmb, d.emb)) : 0
      if (lex === 0 && cos < 0.22 && ecos < 0.45 && !bm.has(d.id)) continue
      if (lex > maxLex) maxLex = lex
      scored.push({ d, lex, cos, ecos, m })
    }
    const out = scored.map((x) => {
      const lexN = maxLex ? x.lex / maxLex : 0
      const s = 0.55 * lexN + 0.2 * (bm.get(x.d.id) ?? 0) + (opts.qEmb ? 0.1 * x.cos + 0.25 * x.ecos : 0.25 * x.cos)
      if (x.cos >= 0.3 || x.ecos >= 0.5) x.m.add('语义相近')
      return { id: x.d.id, score: Math.round(s * 1000) / 1000, matched: [...x.m] }
    })
    out.sort((a, b) => b.score - a.score)
    const top = out[0]?.score ?? 0
    return done(out.filter((x) => x.score >= top * 0.12).slice(0, limit))
  }

  /**
   * kNN exemplars as folder centroids: mean vector of what the user / AI already placed in each folder
   * (imported bookmarks and catch-all folders excluded). One centroid per folder keeps organize() O(items × folders).
   */
  exemplars(): Exemplar[] {
    const cols = new Map((this.db.prepare('SELECT id, name, parent_id FROM collections').all() as Row[]).map((r) => [r.id as string, r]))
    const pathOf = (id: string, depth = 0): string => {
      const c = cols.get(id)
      if (!c) return ''
      const p = c.parent_id as string | null
      return p && cols.has(p) && depth < 20 ? `${pathOf(p, depth + 1)}/${c.name as string}` : (c.name as string)
    }
    const rows = this.db
      .prepare(
        "SELECT t.collection_id c, a.vec v FROM tabs t JOIN tab_ai a ON a.tab_id = t.id WHERE t.collection_id IS NOT NULL AND COALESCE(t.placed_by, 'user') != 'import' AND a.vec IS NOT NULL"
      )
      .all() as Row[]
    const by = new Map<string, Float32Array[]>()
    for (const r of rows) {
      const v = fromBlob(r.v as Buffer)
      const name = cols.get(r.c as string)?.name as string | undefined
      if (!v || !name || /^(未分类|稍后阅读|归档)$/.test(name)) continue
      by.set(r.c as string, [...(by.get(r.c as string) ?? []), v])
    }
    const out: Exemplar[] = []
    for (const [id, vs] of by) {
      if (vs.length < 2) continue
      const c = centroid(vs)
      if (c) out.push({ folderId: id, path: pathOf(id), vec: c, size: vs.length })
    }
    return out
  }

  /** Local vectors for many items at once (organize()). */
  vecMap(): Map<string, Float32Array> {
    const m = new Map<string, Float32Array>()
    for (const r of this.db.prepare('SELECT tab_id, vec FROM tab_ai WHERE vec IS NOT NULL').all() as Row[]) {
      const v = fromBlob(r.vec as Buffer)
      if (v) m.set(r.tab_id as string, v)
    }
    return m
  }

  vecOf(tabId: string): Float32Array | null {
    const r = this.db.prepare('SELECT vec FROM tab_ai WHERE tab_id = ?').get(tabId) as Row | undefined
    return fromBlob(r?.vec as Buffer)
  }

  nearDuplicates(): DupGroup<{
    id: string
    url: string
    title: string
    domain: string
    collectionId: string | null
    createdAt: string
    description: string
    note: string
  }>[] {
    const rows = this.db.prepare('SELECT id, url, title, domain, collection_id, created_at, description, note FROM tabs').all() as Row[]
    return findNearDuplicates(
      rows.map((r) => ({
        id: r.id as string,
        url: r.url as string,
        title: r.title as string,
        domain: r.domain as string,
        collectionId: (r.collection_id as string) ?? null,
        createdAt: r.created_at as string,
        description: (r.description as string) ?? '',
        note: (r.note as string) ?? ''
      }))
    )
  }

  /** Top-k items for RAG (id + compact text). */
  ragContext(ids: string[], max = 12): { id: string; title: string; url: string; text: string }[] {
    const idx = this.ensureIndex()
    return ids
      .slice(0, max)
      .map((id) => idx.get(id))
      .filter((d): d is IndexDoc => !!d)
      .map((d) => ({ id: d.id, title: d.title, url: d.url, text: [d.f.summary || d.f.description, d.f.keywords].filter(Boolean).join(' | ').slice(0, 300) }))
  }
}
