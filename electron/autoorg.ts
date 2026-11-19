import log from 'electron-log/main'
import type { Repo } from './db'
import { localDay } from './db'
import {
  classify,
  learnRules,
  reviewTaxonomy,
  type Classification,
  type FolderInfo,
  type OrgRule,
  type TaxonomyOp,
  type UndoData
} from '../shared/autoorg/engine'
import { SITE_COUNT } from '../shared/autoorg/sites'
import { heuristicEnrich, type Enrichment } from '../shared/ai-heuristic'
import type { CloudEnrichItem, CloudEnrichment } from './ai/service'
import type { TabItem } from '../shared/types'
import type { CloudAI } from './ai/cloud'
import { runEnrichJobs, type EnrichJob, type EnrichOut } from './ai/pipeline'
import { embedLocal } from '../shared/ai/vector'
import { siteOf } from '../shared/cluster'
import { isVagueName } from '../shared/ai/naming'
import { groupName, dominantCategory } from '../shared/autoorg/engine'

export interface OrgSettings {
  autoOrganize: boolean
  autoOrganizeThreshold: number
  /** how many similar items pile up before they get their own folder / sub-group (default 8) */
  groupThreshold?: number
  aiCloudOrganize: boolean
  aiBaseUrl: string
  aiModel: string
  /** fetch page HTML for content-aware enrichment (false = fully offline) */
  aiFetchPages?: boolean
}

export interface AiHooks {
  /** batched cloud enrichment from extracted text; only called when 云端 AI is enabled */
  enrichBatch?: (items: CloudEnrichItem[]) => Promise<Map<string, CloudEnrichment>>
  /** cloud embeddings (when an embedding model is configured) */
  embed?: (texts: string[]) => Promise<Float32Array[]>
  /** local pipeline (fetch + extract + segment + vectors); defaults to in-process */
  pipeline?: (jobs: EnrichJob[], fetchPages: boolean) => Promise<EnrichOut[]>
  /** is the user active right now (idle-aware throttling) */
  userActive?: () => boolean
  online?: () => boolean
  onError?: (msg: string) => void
}

export interface PendingSuggestion {
  tabId: string
  title: string
  domain: string
  target: string
  folderId?: string
  folderPath?: string
  confidence: number
  reason: string
  engine: Classification['engine']
  /** 'bookmark' = an already-bookmarked item (e.g. imported) that AI wants to move to another folder. */
  kind: 'tab' | 'bookmark'
}

type CloudFn = (batch: { i: number; title: string; url: string }[], folders: string[]) => Promise<{ i: number; folder: string; confidence: number }[]>

/** OpenAI-compatible batch classifier (DeepSeek / Qwen / Kimi / OpenAI…). Only ever called when the user enabled cloud AI. */
export function openAiCloud(cfg: { baseUrl: string; model: string; apiKey: string }): CloudFn {
  return async (batch, folders) => {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是书签分类助手。把每个网页归入一个收藏夹路径（用 / 分隔，最多两级，中文）。优先使用已有收藏夹；确实不合适时可以提出新的。只返回 JSON：{"items":[{"i":0,"folder":"开发/文档","confidence":0.0-1.0}]}'
          },
          { role: 'user', content: JSON.stringify({ folders, items: batch }) }
        ]
      })
    })
    if (!res.ok) throw new Error(`AI ${res.status}`)
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const m = /\{[\s\S]*\}/.exec(j.choices?.[0]?.message?.content ?? '')
    const p = m ? (JSON.parse(m[0]) as { items?: unknown }) : {}
    return Array.isArray(p.items)
      ? (p.items as { i: unknown; folder: unknown; confidence: unknown }[])
          .filter((x) => typeof x.i === 'number' && typeof x.folder === 'string' && x.folder.trim())
          .map((x) => ({
            i: x.i as number,
            folder: (x.folder as string).trim().slice(0, 80),
            confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0.5))
          }))
      : []
  }
}

/** Cloud classifier on top of the robust client (retries, zod validation, cache, daily cap). */
export function cloudClassifier(c: CloudAI): CloudFn {
  return async (batch, folders) => c.classifyBatch(batch, folders)
}

export class AutoOrganizer {
  private pending: PendingSuggestion[] = []
  private timers: NodeJS.Timeout[] = []
  private running = false
  private describing = false
  lastRunAt: string | null = null
  lastError: string | null = null
  /** what the last describeSome() did (for the 重新生成摘要 toast) */
  lastDescribe: { engines: string[]; page: number; title: number; cloudError: string | null } | null = null
  hooks: AiHooks = {}

  constructor(
    private repo: Repo,
    private cfg: () => OrgSettings,
    private onChange: () => void,
    private cloud: () => CloudFn | null = () => null
  ) {}

  rules(): OrgRule[] {
    try {
      return JSON.parse(this.repo.getSetting('orgRules') ?? '[]') as OrgRule[]
    } catch {
      return []
    }
  }
  private saveRules(r: OrgRule[]): void {
    this.repo.setSetting('orgRules', JSON.stringify(r.slice(-2000)))
  }
  deleteRule(id: string): void {
    this.saveRules(this.rules().filter((r) => r.id !== id))
  }

  /** User corrections teach rules (called for manual moves only). */
  learn(tabIds: string[], collectionId: string | null): void {
    if (!collectionId) return
    const tabs = this.repo.getTabs(tabIds)
    if (tabs.length) this.saveRules(learnRules(this.rules(), tabs, collectionId))
  }

  /** Resolve "A/B" to a folder id, creating missing levels (recorded in `created`). */
  private folderFor(path: string, created: string[]): string {
    let parent: string | null = null
    for (const name of path
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const cols = this.repo.snapshot().collections
      const hit = cols.find((c) => c.name === name && (c.parentId ?? null) === parent)
      if (hit) parent = hit.id
      else {
        parent = this.repo.createCollection(name, '智能整理创建', parent)
        created.push(parent)
      }
    }
    if (!parent) throw new Error('空的收藏夹路径')
    return parent
  }

  private pathResolver(cols: { id: string; name: string; parentId: string | null }[]): (id: string) => string {
    const byId = new Map(cols.map((c) => [c.id, c]))
    const path = (id: string, depth = 0): string => {
      const c = byId.get(id)
      if (!c) return ''
      return c.parentId && byId.has(c.parentId) && depth < 50 ? `${path(c.parentId, depth + 1)}/${c.name}` : c.name
    }
    return path
  }

  private folderPaths(): string[] {
    const cols = this.repo.snapshot().collections
    const byId = new Map(cols.map((c) => [c.id, c]))
    const path = (id: string): string => {
      const c = byId.get(id)!
      return c.parentId && byId.has(c.parentId) ? `${path(c.parentId)}/${c.name}` : c.name
    }
    return cols.map((c) => path(c.id))
  }

  private async cloudClassify(tabs: TabItem[]): Promise<Map<string, Classification>> {
    const out = new Map<string, Classification>()
    const s = this.cfg()
    const fn = s.aiCloudOrganize ? this.cloud() : null
    if (!fn || !tabs.length) return out
    const cache = JSON.parse(this.repo.getSetting('aiOrgCache') ?? '{}') as Record<string, { folder: string; confidence: number }>
    const todo = tabs.filter((t) => {
      const c = cache[t.normUrl]
      if (c) out.set(t.id, { folderPath: c.folder, confidence: c.confidence, reason: '云端 AI（缓存）', engine: 'cloud' })
      return !c
    })
    const folders = this.folderPaths()
    for (let i = 0; i < todo.length && i < 120; i += 30) {
      const batch = todo.slice(i, i + 30)
      try {
        const r = await fn(
          batch.map((t, k) => ({ i: k, title: t.title.slice(0, 200), url: t.url.slice(0, 300) })),
          folders
        )
        for (const x of r) {
          const t = batch[x.i]
          if (!t) continue
          cache[t.normUrl] = { folder: x.folder, confidence: x.confidence }
          out.set(t.id, { folderPath: x.folder, confidence: x.confidence, reason: '云端 AI', engine: 'cloud' })
        }
        this.lastError = null
      } catch (e) {
        this.lastError = `云端 AI 不可用：${e instanceof Error ? e.message : String(e)}（已改用本地引擎）`
        log.warn('cloud classify failed', e)
        break
      }
    }
    const keys = Object.keys(cache)
    for (const k of keys.slice(0, Math.max(0, keys.length - 5000))) delete cache[k]
    this.repo.setSetting('aiOrgCache', JSON.stringify(cache))
    return out
  }

  /** Classify every unsorted tab; confident ones are moved (one undoable log entry), the rest become suggestions. */
  async organize(trigger = 'auto'): Promise<{ moved: number; pending: number }> {
    const s = this.cfg()
    if (this.running) return { moved: 0, pending: this.pending.length }
    this.running = true
    const t0 = performance.now()
    try {
      const snap = this.repo.snapshot()
      const colIds = new Set(snap.collections.map((c) => c.id))
      const rules = this.rules().filter((r) => colIds.has(r.folderId))
      const imported = new Set(this.repo.importedBookmarkIds())
      const unsorted = snap.tabs.filter((t) => !t.collectionId || imported.has(t.id))
      const exemplars = this.repo.ai.exemplars()
      const vecs = this.repo.ai.vecMap()
      const local = new Map(unsorted.map((t) => [t.id, classify(t, rules, { vec: vecs.get(t.id), exemplars })]))
      const weak = unsorted.filter((t) => (local.get(t.id)?.confidence ?? 0) < s.autoOrganizeThreshold && local.get(t.id)?.engine !== 'rule')
      const cloud = await this.cloudClassify(weak)
      const pick = (t: TabItem) => {
        const a = local.get(t.id)
        const b = cloud.get(t.id)
        return b && (!a || b.confidence > a.confidence) ? b : a
      }
      const groups = new Map<string, { cls: Classification; ids: string[]; bm: number }>()
      const reasons = new Map<string, string>()
      const pending: PendingSuggestion[] = []
      const pathOf = this.pathResolver(snap.collections)
      for (const t of unsorted) {
        const c = pick(t)
        if (!c) continue
        const isBm = !!t.collectionId
        // An imported bookmark already in the folder AI picked stays put (and is no longer "imported-unsorted").
        if (isBm && (c.folderId === t.collectionId || (c.folderPath && pathOf(t.collectionId!) === c.folderPath))) {
          if (s.autoOrganize && c.confidence >= s.autoOrganizeThreshold) this.repo.setPlacedBy([t.id], 'ai')
          continue
        }
        const key = c.folderId ?? `path:${c.folderPath}`
        const target = c.folderId ? (snap.collections.find((x) => x.id === c.folderId)?.name ?? '?') : c.folderPath!
        if (s.autoOrganize && c.confidence >= s.autoOrganizeThreshold) {
          const g = groups.get(key) ?? { cls: c, ids: [], bm: 0 }
          g.ids.push(t.id)
          reasons.set(t.id, c.reason)
          if (isBm) g.bm++
          groups.set(key, g)
        } else if (c.confidence >= 0.35)
          pending.push({
            tabId: t.id,
            title: t.title,
            domain: t.domain,
            target,
            folderId: c.folderId,
            folderPath: c.folderPath,
            confidence: c.confidence,
            reason: c.reason,
            engine: c.engine,
            kind: isBm ? 'bookmark' : 'tab'
          })
      }
      let moved = 0
      if (groups.size) {
        const data: UndoData = { moves: [], created: [], why: [] }
        const parts: string[] = []
        let engine = 'local'
        let bms = 0
        for (const { cls, ids, bm } of groups.values()) {
          bms += bm
          const fid = cls.folderId ?? this.folderFor(cls.folderPath!, data.created!)
          data.moves!.push(...this.repo.moveWithHistory(ids, fid))
          moved += ids.length
          if (cls.engine === 'cloud') engine = 'cloud'
          const label = cls.folderId ? (this.repo.collectionRow(fid)?.name ?? '') : cls.folderPath!
          parts.push(`${label}(${ids.length})`)
          for (const id of ids) this.repo.setOrgReason([id], reasons.get(id) ?? cls.reason)
          if (data.why!.length < 12) data.why!.push(`${label}（${ids.length}）· ${cls.reason}`)
        }
        data.target = bms === 0 ? 'tab' : bms === moved ? 'bookmark' : 'mixed'
        const what = bms === 0 ? `${moved} 个标签` : bms === moved ? `${moved} 个已收藏网址` : `${moved - bms} 个标签 + ${bms} 个已收藏网址`
        this.repo.logOrg('classify', `自动归类 ${what} → ${parts.slice(0, 6).join('、')}${parts.length > 6 ? ' 等' : ''}`, data, engine)
        const hit = new Set([...groups.values()].filter((g) => g.cls.engine === 'rule').map((g) => g.cls.folderId))
        if (hit.size) this.saveRules(this.rules().map((r) => (hit.has(r.folderId) ? { ...r, hits: r.hits + 1 } : r)))
      }
      this.pending = pending.sort((a, b) => b.confidence - a.confidence).slice(0, 500)
      this.lastRunAt = new Date().toISOString()
      if (moved) this.onChange()
      // Dynamic regrouping: as bookmarks accumulate, re-check the folder structure right away (not only nightly).
      if (s.autoOrganize && trigger !== 'review')
        try {
          const ops = this.review(true, ['create', 'nest'])
          if (ops.length) log.info(`taxonomy adjusted after ${trigger}: ${ops.length} op(s)`)
        } catch (e) {
          log.warn('taxonomy review failed', e)
        }
      log.info(
        `auto-organize(${trigger}): moved=${moved} ms=${Math.round(performance.now() - t0)} suggestions=${pending.length} unsorted=${this.repo.snapshot().tabs.filter((t) => !t.collectionId).length}`
      )
      return { moved, pending: pending.length }
    } finally {
      this.running = false
    }
  }

  acceptPending(tabIds: string[]): number {
    const pick = this.pending.filter((p) => tabIds.includes(p.tabId))
    if (!pick.length) return 0
    const data: UndoData = { moves: [], created: [] }
    const by = new Map<string, string[]>()
    for (const p of pick) {
      const fid = p.folderId ?? this.folderFor(p.folderPath!, data.created!)
      by.set(fid, [...(by.get(fid) ?? []), p.tabId])
    }
    for (const [fid, ids] of by) data.moves!.push(...this.repo.moveWithHistory(ids, fid))
    for (const p of pick) this.repo.setOrgReason([p.tabId], `${p.reason}（你已确认）`)
    const bm = pick.filter((p) => p.kind === 'bookmark').length
    data.target = bm === 0 ? 'tab' : bm === pick.length ? 'bookmark' : 'mixed'
    this.repo.logOrg(
      'accept',
      `接受建议：${pick.length - bm ? `${pick.length - bm} 个标签` : ''}${pick.length - bm && bm ? ' + ' : ''}${bm ? `${bm} 个已收藏网址` : ''}`,
      data
    )
    this.pending = this.pending.filter((p) => !tabIds.includes(p.tabId))
    this.onChange()
    return pick.length
  }

  dismissPending(tabIds: string[]): void {
    this.pending = this.pending.filter((p) => !tabIds.includes(p.tabId))
  }

  /** Adjust the folder taxonomy (create / merge / rename / split); every op is its own undoable log entry. */
  review(apply = this.cfg().autoOrganize, only?: TaxonomyOp['kind'][]): TaxonomyOp[] {
    const snap = this.repo.snapshot()
    const folders: FolderInfo[] = snap.collections.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      builtin: c.builtin,
      tabs: snap.tabs.filter((t) => t.collectionId === c.id),
      childCount: snap.collections.filter((k) => k.parentId === c.id).length,
      note: c.note
    }))
    const imported = new Set(this.repo.importedBookmarkIds())
    const ops = reviewTaxonomy(
      folders,
      snap.tabs.filter((t) => !t.collectionId || imported.has(t.id)),
      { growThreshold: this.cfg().groupThreshold ?? 8 }
    ).filter((op) => !only || only.includes(op.kind))
    if (!apply) return ops
    for (const op of ops) {
      try {
        this.applyOp(op)
      } catch (e) {
        log.warn('taxonomy op failed', op, e)
      }
    }
    if (!only) this.repo.setSetting('orgLastReviewDay', localDay())
    if (ops.length) this.onChange()
    return ops
  }

  private applyOp(op: TaxonomyOp): void {
    const data: UndoData = { moves: [], created: [], deleted: [], renamed: [] }
    if (op.kind === 'create') {
      const parent = op.parentName ? this.folderFor(op.parentName, data.created!) : null
      const id = this.repo.createCollection(op.name, `智能整理：${op.reason}`, parent)
      data.created!.push(id)
      data.moves = this.repo.moveWithHistory(op.tabIds, id)
      this.repo.logOrg('create', `新建收藏夹「${op.parentName ? `${op.parentName}/` : ''}${op.name}」并移入 ${op.tabIds.length} 项（${op.reason}）`, data)
    } else if (op.kind === 'merge') {
      const from = this.repo.collectionRow(op.fromId)
      const into = this.repo.collectionRow(op.intoId)
      if (!from || !into) return
      const ids = this.repo
        .snapshot()
        .tabs.filter((t) => t.collectionId === op.fromId)
        .map((t) => t.id)
      data.moves = this.repo.moveWithHistory(ids, op.intoId)
      data.deleted = [from]
      this.repo.deleteCollection(op.fromId)
      this.repo.logOrg('merge', `合并「${from.name}」→「${into.name}」（${op.reason}）`, data)
    } else if (op.kind === 'rename') {
      const c = this.repo.collectionRow(op.id)
      if (!c) return
      data.renamed = [{ id: op.id, from: c.name }]
      this.repo.updateCollection({ id: op.id, name: op.to })
      this.repo.logOrg('rename', `重命名「${c.name}」→「${op.to}」（${op.reason}）`, data)
    } else {
      const parent = this.repo.collectionRow(op.parentId)
      if (!parent) return
      const ex = this.repo.snapshot().collections.find((c) => c.parentId === op.parentId && c.name === op.name)
      const id = ex?.id ?? this.repo.createCollection(op.name, '智能整理：按站点细分', op.parentId)
      if (!ex) data.created!.push(id)
      data.moves = this.repo.moveWithHistory(op.tabIds, id)
      this.repo.logOrg('nest', `细分「${parent.name}」：新建子收藏夹「${op.name}」并移入 ${op.tabIds.length} 项`, data)
    }
  }

  undo(id: string): boolean {
    const ok = this.repo.undoOrg(id)
    if (ok) this.onChange()
    return ok
  }

  undoToday(): number {
    const today = localDay()
    let n = 0
    for (const e of this.repo.orgLog(1000)) if (!e.undone && localDay(new Date(e.at)) === today && this.repo.undoOrg(e.id)) n++
    if (n) this.onChange()
    return n
  }

  /**
   * Background AI enrichment for every tab and bookmark (new, changed, or enriched by an older engine version):
   * fetch page (when allowed) → extract title/meta/og/headings/paragraphs → bilingual keywords, topics, summary,
   * local vector. With 云端 AI on, the extracted text snippet (never raw HTML) is sent in batches; failures fall back
   * to local. Heavy work runs in the AI utility process (hooks.pipeline).
   */
  async describeSome(limit = 10, enrich?: (t: TabItem) => Promise<Partial<Enrichment> & { source?: 'local' | 'cloud' }>, ids?: string[]): Promise<number> {
    if (this.describing && !ids) return 0
    for (let i = 0; this.describing && i < 600; i++) await new Promise((r) => setTimeout(r, 100))
    this.describing = true
    try {
      const s = this.cfg()
      const todo = ids ? this.repo.getTabs(ids).slice(0, 500) : this.repo.needEnrichment(limit)
      if (!todo.length) return 0
      const fetchPages = !!s.aiFetchPages && (this.hooks.online?.() ?? true)
      const pipe = this.hooks.pipeline ?? ((jobs: EnrichJob[], f: boolean) => runEnrichJobs(jobs, { fetch: f }))
      let outs: EnrichOut[]
      try {
        outs = await pipe(
          todo.map((t) => ({ id: t.id, title: t.title, url: t.url, domain: t.domain })),
          fetchPages
        )
      } catch (e) {
        log.warn('ai pipeline failed; local title/url only', e)
        outs = await runEnrichJobs(
          todo.map((t) => ({ id: t.id, title: t.title, url: t.url, domain: t.domain })),
          { fetch: false }
        )
      }
      const byId = new Map(outs.map((o) => [o.id, o]))
      const cloudOn = s.aiCloudOrganize
      let cloud = new Map<string, CloudEnrichment>()
      if (cloudOn && this.hooks.enrichBatch) {
        try {
          cloud = await this.hooks.enrichBatch(
            todo.map((t) => {
              const o = byId.get(t.id)
              return {
                id: t.id,
                title: t.title,
                url: t.url,
                domain: t.domain,
                snippet: o?.e.content ?? '',
                page: o?.page ?? null,
                keywords: o?.e.keywords,
                topics: o?.e.topics
              }
            })
          )
          this.lastError = null
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : String(e)
          this.hooks.onError?.(this.lastError)
        }
      } else if (cloudOn && enrich) {
        for (const t of todo) {
          const r = await enrich(t).catch(() => null)
          if (r && r.source !== 'local') cloud.set(t.id, r)
        }
      }
      const embedTodo: { id: string; text: string }[] = []
      const stat = { engines: new Set<string>(), page: 0, title: 0 }
      for (const t of todo) {
        const o = byId.get(t.id)
        const local = o?.e ?? { ...heuristicEnrich(t.title, t.url, t.domain), content: '' }
        const c = cloud.get(t.id)
        const e: Enrichment = {
          description: c?.description || local.description,
          keywords: c?.keywords?.length ? [...new Set([...c.keywords, ...local.keywords])].slice(0, 12) : local.keywords,
          topics: c?.topics?.length ? c.topics : local.topics,
          summary: c?.summary || local.summary,
          lang: c?.lang || local.lang
        }
        this.repo.setEnrichment(t.id, e, c ? 'cloud' : 'local')
        const points = c?.points?.length ? c.points : (o?.e.points ?? [])
        const src = o?.fetchStatus === 'ok' && (o.e.summarySrc === 'page' || !!c) ? 'page' : 'title'
        this.repo.ai.setAiData(t.id, { points, summarySrc: src, engine: c ? (c.engine ?? '云端 AI') : '本地摘要' })
        // reuse the HTTP status seen while fetching as the link check (definitive codes only)
        if (o?.httpCode) {
          const code = o.httpCode
          const status = code >= 200 && code < 400 ? 'ok' : code === 404 || code === 410 || code >= 500 ? 'broken' : null
          if (status)
            this.repo.setLinkStatus(t.id, { status, statusCode: code, note: status === 'broken' ? `HTTP ${code}` : null, checkedAt: new Date().toISOString() })
        }
        stat.engines.add(c ? (c.engine ?? '云端 AI') : '本地摘要')
        if (src === 'page') stat.page++
        else stat.title++
        const vec = c
          ? embedLocal({ title: t.title, keywords: e.keywords, topics: e.topics, text: local.content, site: siteOf(t.domain) })
          : o
            ? Float32Array.from(o.vec)
            : null
        this.repo.ai.setAiData(t.id, { content: local.content, contentHash: o?.contentHash ?? null, fetchStatus: o?.fetchStatus ?? 'offline', vec })
        if (cloudOn && this.hooks.embed) embedTodo.push({ id: t.id, text: [t.title, e.summary, e.keywords.join(' '), local.content.slice(0, 500)].join('\n') })
      }
      if (embedTodo.length && this.hooks.embed)
        try {
          const vs = await this.hooks.embed(embedTodo.map((x) => x.text))
          embedTodo.forEach((x, i) => vs[i] && this.repo.ai.setAiData(x.id, { emb: vs[i], embModel: 'cloud' }))
        } catch (e) {
          log.warn('embeddings failed', e)
        }
      this.lastDescribe = { engines: [...stat.engines], page: stat.page, title: stat.title, cloudError: cloudOn && !cloud.size ? this.lastError : null }
      this.onChange()
      return todo.length
    } finally {
      this.describing = false
    }
  }

  /**
   * 1.4.0 upgrade: folders TabNest created earlier with raw-token names ("grok", "products", "github.com")
   * are renamed to meaningful Chinese-first names. Each rename is logged and undoable. Runs once.
   */
  upgradeFolderNames(force = false): number {
    if (!force && this.repo.getSetting('naming140') === '1') return 0
    const snap = this.repo.snapshot()
    const taken = new Set(snap.collections.map((c) => c.name.toLowerCase()))
    let n = 0
    for (const c of snap.collections) {
      if (c.builtin || !c.note.startsWith('智能整理') || !isVagueName(c.name)) continue
      const tabs = snap.tabs.filter((t) => t.collectionId === c.id)
      if (!tabs.length) continue
      const cat = dominantCategory(tabs)
      const to = groupName(tabs, [c.name], cat && cat.share >= 0.6 ? cat.folder : null)
      if (!to || taken.has(to.toLowerCase()) || to === c.name) continue
      taken.add(to.toLowerCase())
      this.repo.updateCollection({ id: c.id, name: to })
      this.repo.logOrg('rename', `命名优化「${c.name}」→「${to}」（1.4 升级：自动创建的收藏夹名称更易懂）`, { renamed: [{ id: c.id, from: c.name }] })
      n++
    }
    this.repo.setSetting('naming140', '1')
    if (n) {
      log.info(`folder naming upgrade: renamed ${n}`)
      this.onChange()
    }
    return n
  }

  /** One-click merge of every near-duplicate group (keeps the best item); one undoable log entry. */
  mergeDuplicates(keys?: string[]): { groups: number; removed: number; logId: string | null } {
    const groups = this.repo.ai.nearDuplicates().filter((g) => !keys || keys.includes(g.key))
    const data: UndoData = { trashed: [], kept: [] }
    let removed = 0
    for (const g of groups) {
      const d = this.repo.mergeDuplicates(
        g.keepId,
        g.items.map((x) => x.id),
        false
      )
      data.trashed!.push(...(d.trashed ?? []))
      data.kept!.push(...(d.kept ?? []))
      removed += d.trashed?.length ?? 0
    }
    if (!groups.length) return { groups: 0, removed: 0, logId: null }
    const logId = this.repo.logOrg('dedupe', `合并重复 ${groups.length} 组，移除 ${removed} 项到回收站（保留已整理 / 有备注 / 信息更全的一条）`, data)
    this.onChange()
    return { groups: groups.length, removed, logId }
  }

  status() {
    const s = this.cfg()
    const cols = new Map(this.repo.snapshot().collections.map((c) => [c.id, c.name]))
    return {
      enabled: s.autoOrganize,
      threshold: s.autoOrganizeThreshold,
      engine: s.aiCloudOrganize && this.cloud() ? ('cloud' as const) : ('local' as const),
      cloudEnabled: s.aiCloudOrganize,
      cloudReady: !!this.cloud(),
      model: s.aiModel,
      siteCount: SITE_COUNT,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      lastReviewDay: this.repo.getSetting('orgLastReviewDay'),
      rules: this.rules().map((r) => ({ ...r, folderName: cols.get(r.folderId) ?? '（已删除）' })),
      pending: this.pending.filter((p) => !p.folderId || cols.has(p.folderId)),
      log: this.repo.orgLog(100).map(({ data, ...e }) => ({
        ...e,
        count: data.moves?.length || data.trashed?.length || 0,
        target: data.target ?? 'tab',
        why: data.why ?? []
      })),
      duplicates: this.repo.ai.nearDuplicates().length,
      undescribed: this.repo.enrichmentStats().pending,
      enrichment: this.repo.enrichmentStats()
    }
  }

  start(enrich?: (t: TabItem) => Promise<Partial<Enrichment> & { source?: 'local' | 'cloud' }>): void {
    this.stop()
    // Idle-aware enrichment: while the user is active only a small batch per minute (network + CPU stay low),
    // when idle a bigger one. Cloud batches are smaller (rate limits / cost).
    const tick = () => {
      const active = this.hooks.userActive?.() ?? false
      const cloud = this.cfg().aiCloudOrganize
      const n = cloud ? (active ? 8 : 16) : active ? 15 : 60
      void this.describeSome(n, enrich).catch((e) => log.warn('enrich', e))
    }
    this.timers.push(setInterval(tick, 60000))
    setTimeout(() => {
      try {
        this.upgradeFolderNames()
      } catch (e) {
        log.warn('naming upgrade failed', e)
      }
      tick()
    }, 15000).unref()
    // nightly taxonomy review: first check after 02:00 local each day (or on the next run if the PC was off)
    this.timers.push(
      setInterval(() => {
        if (!this.cfg().autoOrganize) return
        if (this.repo.getSetting('orgLastReviewDay') !== localDay() && new Date().getHours() >= 2) this.review()
      }, 30 * 60000)
    )
    for (const t of this.timers) t.unref()
  }

  stop(): void {
    this.timers.forEach(clearInterval)
    this.timers = []
  }
}
