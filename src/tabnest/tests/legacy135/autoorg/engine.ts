import { tokenize } from '../ai-heuristic'
import { siteOf, suggestClusters } from '../cluster'
import type { TabItem } from '../../../shared/types'
import { KEYWORD_HINTS, SITE_TABLE } from './sites'

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
  engine: 'rule' | 'table' | 'keyword' | 'cloud'
}

export function classify(t: Pick<TabItem, 'url' | 'domain' | 'title'>, rules: OrgRule[] = []): Classification | null {
  const host = hostOf(t)
  const site = siteOf(host)
  const dr = rules.find((r) => r.kind === 'domain' && (r.match === site || r.match === host))
  if (dr) return { folderId: dr.folderId, confidence: 0.97, reason: `规则：${dr.match} → 你上次的归类`, engine: 'rule' }
  const toks = new Set(tokenize(t.title, t.url).map((x) => x.toLowerCase()))
  const kr = rules.find((r) => r.kind === 'keyword' && toks.has(r.match))
  if (kr) return { folderId: kr.folderId, confidence: 0.82, reason: `规则：关键词「${kr.match}」`, engine: 'rule' }
  const path = pathOf(t.url)
  for (const [k, v] of SITE_TABLE)
    if (v.path && (host === k.split('/')[0] || host.endsWith('.' + k.split('/')[0])) && path.startsWith(v.path))
      return { folderPath: v.folder, confidence: 0.92, reason: `站点库：${k}`, engine: 'table' }
  const exact = SITE_TABLE.get(host)
  if (exact && !exact.path) return { folderPath: exact.folder, confidence: 0.9, reason: `站点库：${host}`, engine: 'table' }
  const parts = host.split('.')
  for (let i = 1; i < parts.length - 1; i++) {
    const h = SITE_TABLE.get(parts.slice(i).join('.'))
    if (h && !h.path) return { folderPath: h.folder, confidence: 0.85, reason: `站点库：${parts.slice(i).join('.')}`, engine: 'table' }
  }
  const text = `${t.title} ${path}`
  const hits = KEYWORD_HINTS.filter(([re]) => re.test(text)).map(([, f]) => f)
  if (hits.length) {
    const top = hits[0]
    const agree = hits.filter((h) => h === top).length
    return { folderPath: top, confidence: hits.length === 1 || agree > 1 ? 0.62 : 0.5, reason: '标题/路径关键词', engine: 'keyword' }
  }
  return null
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
    const name = [...(free[0].topics ?? []), ...free[0].keywords].find((k) => k.toLowerCase() === [...by.entries()].find(([, l]) => l === list)![0])!
    free.forEach((t) => used.add(t.id))
    out.push({ name, tabIds: free.map((t) => t.id) })
  }
  return out
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
    const leaf = c.kind === 'domain' ? c.folderName : (distinctiveToken(tabs, unsorted) ?? c.folderName)
    const name = cat && cat.share >= 0.6 && c.kind !== 'domain' ? cat.folder.split('/').at(-1)! : leaf
    if (names.has(norm(name))) continue
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
    if (f.builtin || merged.has(f.id) || !VAGUE.test(f.name.trim()) || f.tabs.length < 3) continue
    const cat = dominantCategory(f.tabs)
    const to = cat && cat.share >= 0.6 ? cat.folder.split('/').at(-1)! : null
    if (to && !names.has(norm(to))) {
      names.add(norm(to))
      ops.push({ kind: 'rename', id: f.id, to, reason: `名称含糊，${Math.round(cat!.share * 100)}% 内容属于「${to}」` })
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
      ops.push({ kind: 'nest', parentId: f.id, name: c.folderName, tabIds: c.tabIds, reason: `「${f.name}」有 ${f.tabs.length} 项，按站点细分` })
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
}
