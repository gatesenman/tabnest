import { tokenize } from '../ai-heuristic'
import { siteOf, suggestClusters } from '../cluster'
import type { TabItem } from '../types'
import { KEYWORD_HINTS, SITE_TABLE } from './sites'
import { cosine } from '../ai/vector'
import { friendlySite, isVagueName, nameFolder } from '../ai/naming'

// ---------------------------------------------------------------- rules (learned from user corrections)
export interface OrgRule {
  id: string
  kind: 'domain' | 'keyword'
  /** registrable site for domain rules, lowercase token for keyword rules */
  match: string
  folderId: string
  createdAt: string
  hits: number
}

const hostOf = (t: Pick<TabItem, 'url' | 'domain'>) => {
  try {
    return new URL(t.url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return (t.domain || '').toLowerCase().replace(/^www\./, '')
  }
}
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname
  } catch {
    return '/'
  }
}

/**
 * A user moving tabs into a folder teaches TabNest: every site moved becomes a domain rule; a token shared
 * by ≥2 tabs from different sites becomes a keyword rule. Newer rules replace older ones for the same match.
 */
export function learnRules(
  existing: OrgRule[],
  moved: TabItem[],
  folderId: string,
  now = new Date().toISOString(),
  id = () => Math.random().toString(36).slice(2)
): OrgRule[] {
  const out = [...existing]
  const put = (kind: OrgRule['kind'], match: string) => {
    const i = out.findIndex((r) => r.kind === kind && r.match === match)
    if (i >= 0) {
      if (out[i].folderId === folderId) return
      out.splice(i, 1)
    }
    out.push({ id: id(), kind, match, folderId, createdAt: now, hits: 0 })
  }
  for (const s of new Set(moved.map((t) => siteOf(hostOf(t))).filter(Boolean))) put('domain', s)
  const sites = new Set(moved.map((t) => siteOf(hostOf(t))))
  if (moved.length >= 2 && sites.size >= 2) {
    const sets = moved.map(
      (t) =>
        new Set(
          tokenize(t.title, t.url)
            .map((x) => x.toLowerCase())
            .filter((x) => x.length >= 2)
        )
    )
    for (const tok of sets[0]) if (sets.every((s) => s.has(tok))) put('keyword', tok)
  }
  return out
}

// ---------------------------------------------------------------- classifier
export interface Classification {
  /** folder path like "开发/文档" (table / keyword) or a concrete folder id (rule) */
  folderPath?: string
  folderId?: string
  confidence: number
  reason: string
  /** human-readable evidence, e.g. ["域名 github.com → 代码托管", "关键词 react"] */
  basis?: string[]
  engine: 'rule' | 'table' | 'keyword' | 'similar' | 'cloud'
}

export interface ClassifyCtx {
  /** local vector of the item being classified */
  vec?: Float32Array | null
  /** already-sorted items (by user / AI) that act as kNN exemplars */
  exemplars?: Exemplar[]
}
export interface Exemplar {
  folderId: string
  /** folder path ("开发/文档") so table/keyword votes and kNN votes for the same folder add up */
  path: string
  vec: Float32Array
  /** members behind a folder centroid (1 for a single item) */
  size?: number
}

/** Map evidence points to a calibrated probability (fitted on tests/fixtures/classify-fixture.json). */
export function calibrate(top: number, second: number): number {
  const z = 1.1 * top + 0.5 * (top - second) - 1.7
  return Math.round((1 / (1 + Math.exp(-z))) * 100) / 100
}

const HINTS_G: [RegExp, string][] = KEYWORD_HINTS.map(([re, f]) => [new RegExp(re.source, re.flags.replace('g', '') + 'g'), f])
/** kNN evidence: weak below ~0.45 cosine, strong when an item clearly resembles a folder's content. */
const knnPoints = (sum: number, n: number) => {
  const s = sum / n
  return Math.min(3.2, (s >= 0.45 ? 4 * s - 0.6 : 1.2 * s) + 0.15 * (n - 1))
}
const leaf = (p: string) => p.split('/').at(-1)!

/**
 * Hybrid classifier. Evidence from learned rules, the site table, title/path keywords, AI content keywords
 * (description / keywords / topics from page content) and kNN similarity to already-sorted items is summed per
 * candidate folder; confidence is calibrated from the winning score and its margin. `basis` explains the decision.
 */
export function classify(
  t: Pick<TabItem, 'url' | 'domain' | 'title'> & Partial<Pick<TabItem, 'description' | 'keywords' | 'topics'>>,
  rules: OrgRule[] = [],
  ctx: ClassifyCtx = {}
): Classification | null {
  const host = hostOf(t)
  const site = siteOf(host)
  const path = pathOf(t.url)
  type Cand = { score: number; basis: string[]; folderId?: string; folderPath?: string; engines: Set<Classification['engine']> }
  const cands = new Map<string, Cand>()
  const vote = (key: string, pts: number, basis: string, engine: Classification['engine'], target: { folderId?: string; folderPath?: string }) => {
    const k = key.toLowerCase()
    const c = cands.get(k) ?? { score: 0, basis: [], engines: new Set() }
    c.score += pts
    if (!c.basis.includes(basis)) c.basis.push(basis)
    c.engines.add(engine)
    if (target.folderId) c.folderId = target.folderId
    if (target.folderPath && !c.folderPath) c.folderPath = target.folderPath
    cands.set(k, c)
  }
  // 1) learned rules (strongest: the user did this before)
  const dr = rules.find((r) => r.kind === 'domain' && (r.match === site || r.match === host))
  if (dr) vote('id:' + dr.folderId, 4, `规则：${dr.match} → 你的归类`, 'rule', { folderId: dr.folderId })
  const content = [...(t.keywords ?? []), ...(t.topics ?? [])].join(' ')
  const toks = new Set([...tokenize(t.title, t.url), ...(t.keywords ?? [])].map((x) => x.toLowerCase()))
  const kr = rules.find((r) => r.kind === 'keyword' && toks.has(r.match))
  if (kr) vote('id:' + kr.folderId, 2.4, `规则：关键词「${kr.match}」`, 'rule', { folderId: kr.folderId })
  // 2) site table
  let table: { folder: string; pts: number; key: string } | null = null
  for (const [k, v] of SITE_TABLE)
    if (v.path && (host === k.split('/')[0] || host.endsWith('.' + k.split('/')[0])) && path.startsWith(v.path)) {
      table = { folder: v.folder, pts: 3.2, key: k }
      break
    }
  if (!table) {
    const exact = SITE_TABLE.get(host)
    if (exact && !exact.path) table = { folder: exact.folder, pts: 3, key: host }
  }
  if (!table) {
    const parts = host.split('.')
    for (let i = 1; i < parts.length - 1 && !table; i++) {
      const h = SITE_TABLE.get(parts.slice(i).join('.'))
      if (h && !h.path) table = { folder: h.folder, pts: 2.6, key: parts.slice(i).join('.') }
    }
  }
  if (table) vote('path:' + table.folder, table.pts, `域名 ${table.key} → ${leaf(table.folder)}`, 'table', { folderPath: table.folder })
  // 3) keywords: title/path (strong) and AI content keywords (from fetched page)
  const titleText = `${t.title} ${path.replace(/[/_\-.]+/g, ' ')}`
  const contentText = `${t.description ?? ''} ${content}`
  for (const [g, folder] of HINTS_G) {
    const inTitle = [...titleText.matchAll(g)].map((m) => m[0])
    const inContent = [...contentText.matchAll(g)].map((m) => m[0])
    if (!inTitle.length && !inContent.length) continue
    const uniq = new Set([...inTitle, ...inContent].map((x) => x.toLowerCase()))
    const pts = (inTitle.length ? 1 : 0) + (inContent.length ? 0.8 : 0) + Math.min(0.6, (uniq.size - 1) * 0.2)
    vote('path:' + folder, pts, `关键词 ${[...uniq].slice(0, 2).join('、')}`, 'keyword', { folderPath: folder })
  }
  // 4) kNN similarity to already-sorted items
  if (ctx.vec && ctx.exemplars?.length) {
    const sims: { e: Exemplar; s: number }[] = []
    for (const e of ctx.exemplars) {
      const s = cosine(ctx.vec, e.vec)
      if (s >= 0.32) sims.push({ e, s })
    }
    sims.sort((a, b) => b.s - a.s)
    const top = sims.slice(0, 7)
    const by = new Map<string, { e: Exemplar; s: number; n: number }>()
    for (const x of top) {
      const k = x.e.path.toLowerCase()
      const cur = by.get(k) ?? { e: x.e, s: 0, n: 0 }
      cur.s += x.s
      cur.n++
      by.set(k, cur)
    }
    for (const [, v] of by) {
      // path key so it merges with table/keyword votes for the same folder; folderId pins the real folder
      const label = v.e.size && v.e.size > 1 ? `相似：与「${leaf(v.e.path)}」收藏夹内容相近` : `相似：与「${leaf(v.e.path)}」中 ${v.n} 项内容相近`
      vote('path:' + v.e.path, knnPoints(v.s, v.n), label, 'similar', { folderId: v.e.folderId, folderPath: v.e.path })
    }
  }
  if (!cands.size) return null
  const ranked = [...cands.values()].sort((a, b) => b.score - a.score)
  const [best, second] = ranked
  const engine: Classification['engine'] = best.engines.has('rule')
    ? 'rule'
    : best.engines.has('table')
      ? 'table'
      : best.engines.has('similar')
        ? 'similar'
        : 'keyword'
  const basis = best.basis.slice(0, 4)
  if (second && second.score > best.score * 0.6) basis.push(`备选：${second.folderPath ? leaf(second.folderPath) : '已学习收藏夹'}`)
  return {
    folderId: best.folderId,
    folderPath: best.folderId ? undefined : best.folderPath,
    confidence: calibrate(best.score, second?.score ?? 0),
    reason: `依据：${basis.join('；')}`,
    basis,
    engine
  }
}

/** Category (table folder) that most of these tabs belong to, with its share. */
export function dominantCategory(tabs: TabItem[]): { folder: string; share: number } | null {
  const c = new Map<string, number>()
  for (const t of tabs) {
    const k = classify(t)
    if (k?.folderPath && k.confidence >= 0.6) c.set(k.folderPath, (c.get(k.folderPath) ?? 0) + 1)
  }
  const top = [...c].sort((a, b) => b[1] - a[1])[0]
  return top && tabs.length ? { folder: top[0], share: top[1] / tabs.length } : null
}

// ---------------------------------------------------------------- taxonomy review
export interface FolderInfo {
  id: string
  name: string
  parentId: string | null
  builtin: boolean
  tabs: TabItem[]
  childCount: number
  /** "智能整理…" marks folders TabNest created (eligible for the vague-name upgrade) */
  note?: string
}

export type TaxonomyOp =
  | { kind: 'create'; name: string; parentName: string | null; tabIds: string[]; reason: string }
  | { kind: 'merge'; fromId: string; intoId: string; reason: string }
  | { kind: 'rename'; id: string; to: string; reason: string }
  | { kind: 'nest'; parentId: string; name: string; tabIds: string[]; reason: string }

const VAGUE = /^(新建文件夹|新文件夹|未命名|untitled|new folder|杂项|其他|其它|misc|temp|临时|收藏|stuff)\s*\(?\d*\)?$/i
const norm = (s: string) => s.toLowerCase().replace(/[\s_\-·/]+/g, '')

/** TF-IDF: the most distinctive token of `group` relative to `corpus` (for naming new folders). */
export function distinctiveToken(group: TabItem[], corpus: TabItem[]): string | null {
  const df = new Map<string, number>()
  for (const t of corpus) for (const k of new Set(tokenize(t.title, t.url).map((x) => x.toLowerCase()))) df.set(k, (df.get(k) ?? 0) + 1)
  const tf = new Map<string, number>()
  for (const t of group) for (const k of new Set(tokenize(t.title, t.url).map((x) => x.toLowerCase()))) tf.set(k, (tf.get(k) ?? 0) + 1)
  let best: [string, number] | null = null
  for (const [k, n] of tf) {
    const score = (n / group.length) * Math.log((1 + corpus.length) / (1 + (df.get(k) ?? 0)) + 1)
    if (n >= 2 && (!best || score > best[1])) best = [k, score]
  }
  return best?.[0] ?? null
}

/**
 * Topic groups across different sites: items sharing an AI topic / keyword (e.g. 10 different 收藏夹管理 tools).
 * Greedy: biggest topic first, each item joins at most one group. Needs ≥ min items from ≥ 2 sites.
 */
export function topicClusters(tabs: TabItem[], min: number): { name: string; tabIds: string[] }[] {
  const GENERIC = /^(网页|网站|页面|文章|首页|主页|工具|链接|博客|视频|官网|web|page|site|home|index|www|com|html|http|https)$/i
  const by = new Map<string, TabItem[]>()
  for (const t of tabs) {
    const terms = new Set([...(t.topics ?? []), ...t.keywords].map((k) => k.trim()).filter((k) => [...k].length >= 2 && !GENERIC.test(k)))
    for (const k of terms) by.set(k.toLowerCase(), [...(by.get(k.toLowerCase()) ?? []), t])
  }
  const used = new Set<string>()
  const out: { name: string; tabIds: string[] }[] = []
  for (const [, list] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const free = list.filter((t) => !used.has(t.id))
    if (free.length < min || new Set(free.map((t) => t.domain)).size < 2) continue
    const raw = [...(free[0].topics ?? []), ...free[0].keywords].find((k) => k.toLowerCase() === [...by.entries()].find(([, l]) => l === list)![0])!
    const name = groupName(free, [raw])
    if (!name) continue
    free.forEach((t) => used.add(t.id))
    out.push({ name, tabIds: free.map((t) => t.id) })
  }
  return out
}

/** Most frequent AI topics / keywords of a group (display forms), best first. */
export function groupTerms(tabs: Pick<TabItem, 'keywords' | 'topics'>[], max = 12): string[] {
  const n = new Map<string, { k: string; c: number }>()
  for (const t of tabs)
    for (const k of new Set([...(t.topics ?? []), ...t.keywords])) {
      const key = k.toLowerCase()
      const cur = n.get(key) ?? { k, c: 0 }
      cur.c++
      n.set(key, cur)
    }
  return [...n.values()]
    .filter((x) => x.c >= Math.max(2, tabs.length * 0.2))
    .sort((a, b) => b.c - a.c)
    .slice(0, max)
    .map((x) => x.k)
}

/** Short, Chinese-first folder name for a group (null = nothing meaningful → don't create). */
export function groupName(tabs: TabItem[], lead: string[] = [], category: string | null = null): string | null {
  const sites = new Map<string, number>()
  for (const t of tabs) sites.set(siteOf(t.domain || ''), (sites.get(siteOf(t.domain || '')) ?? 0) + 1)
  const top = [...sites].sort((a, b) => b[1] - a[1])[0]
  return nameFolder({
    terms: [...lead.filter(Boolean), ...groupTerms(tabs)],
    category,
    site: top && tabs.length ? { site: top[0], share: top[1] / tabs.length } : null
  })
}

export function reviewTaxonomy(folders: FolderInfo[], unsorted: TabItem[], opts: { growThreshold?: number; nestMin?: number } = {}): TaxonomyOp[] {
  const grow = opts.growThreshold ?? 8
  const nestMin = opts.nestMin ?? 5
  const ops: TaxonomyOp[] = []
  const names = new Set(folders.map((f) => norm(f.name)))
  const grouped = new Set<string>()
  // 1b) topic groups (cross-site, from AI keywords/topics) among loose items …
  for (const g of topicClusters(unsorted, grow)) {
    g.tabIds.forEach((id) => grouped.add(id))
    if (names.has(norm(g.name))) continue
    names.add(norm(g.name))
    ops.push({
      kind: 'create',
      name: g.name,
      parentName: null,
      tabIds: g.tabIds,
      reason: `${g.tabIds.length} 个同类网址（主题「${g.name}」）已达分组阈值 ${grow}`
    })
  }
  // 1) grow: an unsorted cluster with ≥ grow similar items gets its own folder
  for (const c of suggestClusters(
    unsorted.filter((t) => !grouped.has(t.id)),
    grow + 1
  )) {
    c.tabIds.forEach((id) => grouped.add(id))
    const tabs = unsorted.filter((t) => c.tabIds.includes(t.id))
    const cat = dominantCategory(tabs)
    const name =
      c.kind === 'domain'
        ? friendlySite(c.folderName)
        : groupName(tabs, [distinctiveToken(tabs, unsorted) ?? c.folderName], cat && cat.share >= 0.6 ? cat.folder : null)
    if (!name || names.has(norm(name))) continue
    names.add(norm(name))
    ops.push({
      kind: 'create',
      name,
      parentName: cat && cat.share >= 0.6 ? cat.folder.split('/')[0] : null,
      tabIds: c.tabIds,
      reason: `${c.tabIds.length} 个相似标签（${c.label}）`
    })
  }
  // … and inside a mixed folder: ≥ grow same-topic bookmarks get their own sub-group (existing bookmarks included)
  const nested = new Set<string>()
  for (const f of folders) {
    if (f.tabs.length < grow + 2) continue
    for (const g of topicClusters(f.tabs, grow)) {
      if (g.tabIds.length >= f.tabs.length * 0.8 || norm(g.name) === norm(f.name)) continue
      g.tabIds.forEach((id) => nested.add(id))
      ops.push({
        kind: 'nest',
        parentId: f.id,
        name: g.name,
        tabIds: g.tabIds,
        reason: `「${f.name}」里有 ${g.tabIds.length} 个「${g.name}」类网址，达到分组阈值 ${grow}`
      })
    }
  }
  // 2) merge near-empty folders into a similar sibling
  const merged = new Set<string>()
  for (const f of folders) {
    if (f.builtin || f.childCount || f.tabs.length > 1 || merged.has(f.id)) continue
    const sibs = folders.filter((s) => s.id !== f.id && s.parentId === f.parentId && !merged.has(s.id) && s.tabs.length > f.tabs.length)
    const fc = dominantCategory(f.tabs)
    const target =
      sibs.find((s) => norm(s.name) === norm(f.name) || norm(s.name).includes(norm(f.name)) || norm(f.name).includes(norm(s.name))) ??
      (fc ? sibs.find((s) => dominantCategory(s.tabs)?.folder === fc.folder) : undefined)
    if (target) {
      merged.add(f.id)
      ops.push({ kind: 'merge', fromId: f.id, intoId: target.id, reason: `「${f.name}」几乎为空，与「${target.name}」相近` })
    }
  }
  // 3) rename vague folders after their dominant category
  for (const f of folders) {
    const auto = (f.note ?? '').startsWith('智能整理')
    if (f.builtin || merged.has(f.id) || f.tabs.length < 3) continue
    if (!VAGUE.test(f.name.trim()) && !(auto && isVagueName(f.name))) continue
    const cat = dominantCategory(f.tabs)
    const to = groupName(f.tabs, [], cat && cat.share >= 0.6 ? cat.folder : null)
    if (to && norm(to) !== norm(f.name) && !names.has(norm(to))) {
      names.add(norm(to))
      ops.push({
        kind: 'rename',
        id: f.id,
        to,
        reason: cat && cat.share >= 0.6 ? `名称含糊，${Math.round(cat.share * 100)}% 内容属于「${to}」` : `名称「${f.name}」含糊，按内容主题改为「${to}」`
      })
    }
  }
  // 4) split big folders into per-site subfolders
  for (const f of folders) {
    if (merged.has(f.id) || f.tabs.length < nestMin * 2 + 2) continue
    const subs = suggestClusters(
      f.tabs.filter((t) => !nested.has(t.id)),
      nestMin
    ).filter((c) => c.kind === 'domain')
    if (subs.length < 2) continue
    for (const c of subs)
      ops.push({ kind: 'nest', parentId: f.id, name: friendlySite(c.folderName), tabIds: c.tabIds, reason: `「${f.name}」有 ${f.tabs.length} 项，按站点细分` })
  }
  return ops
}

// ---------------------------------------------------------------- undo log
export interface UndoData {
  moves?: { tabId: string; from: string | null; placedBy?: string | null }[]
  /** 'bookmark' when the log entry re-sorted existing bookmarks (UI filter 标签 / 收藏). */
  target?: 'tab' | 'bookmark' | 'mixed'
  created?: string[]
  deleted?: { id: string; name: string; parentId: string | null; note: string }[]
  renamed?: { id: string; from: string }[]
  /** per target folder: why AI moved items there (shown in the 智能整理 log) */
  why?: string[]
  /** dedupe merge: removed items went to the recycle bin; restore them on undo */
  trashed?: string[]
  /** dedupe merge: fields of the kept item before it absorbed the others' metadata */
  kept?: { tabId: string; collectionId: string | null; description: string; keywords: string[]; note: string }[]
}
