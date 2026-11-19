import { normalizeUrl } from '../url'
import { siteOf } from '../cluster'

/** Extra share / referral params that never change page content. */
const NOISE =
  /^(utm_\w+|spm\w*|from|share_\w+|share|vd_source|ref|ref_\w+|source|src|_t|t_|timestamp|scene|sharer_\w+|is_from_webapp|sender_device|wechat_\w+|chksm|mpshare|sessionid|tt_from|isappinstalled|f|bd_vid|track_id|trackid|ved|ei|sa|usg|oq|gs_lcp|sclient)$/i
const MOBILE = /^(m|mobile|wap|touch|h5)\./

/**
 * Canonical key for near-duplicate detection: http→https, no www./m./mobile./wap., tracking & share params dropped,
 * trailing slash / index.html removed, #fragment dropped unless it is a hash-route (#/…).
 */
export function dupKey(url: string): string {
  try {
    const rawHash = (() => {
      try {
        return new URL(url.trim()).hash
      } catch {
        return ''
      }
    })()
    const u = new URL(normalizeUrl(url))
    u.hostname = u.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(MOBILE, '')
    for (const k of [...u.searchParams.keys()]) if (NOISE.test(k)) u.searchParams.delete(k)
    u.pathname = u.pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, '/').replace(/\/+$/, '') || '/'
    const hash = rawHash.startsWith('#/') || rawHash.startsWith('#!/') ? rawHash : ''
    u.hash = ''
    u.protocol = 'https:'
    let s = u.toString().replace(/\/(\?|$)/, '$1')
    if (hash) s += hash
    return s
  } catch {
    return url.trim().toLowerCase()
  }
}

/** Title normalized for "same content" detection; empty when too generic/short to trust. */
export function titleKey(title: string): string {
  const t = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\(\d+\)\s*/, '') // "(3) 消息" counters
    .replace(/[\s\-_|·—–:：,，.。!！?？"'“”()（）[\]【】]+/g, ' ')
    .trim()
  if ([...t.replace(/\s/g, '')].length < 8) return ''
  if (/^(home|首页|登录|login|新标签页|new tab|untitled|loading)/.test(t)) return ''
  return t
}

export interface DupItem {
  id: string
  url: string
  title: string
  domain: string
  collectionId: string | null
  createdAt: string
  description?: string
  note?: string
}

export interface DupGroup<T extends DupItem = DupItem> {
  key: string
  kind: 'exact' | 'url' | 'title'
  reason: string
  items: T[]
  keepId: string
}

/** Pick the best item to keep: organized > has note > richer metadata > oldest. */
export function pickKeep<T extends DupItem>(items: T[]): T {
  return [...items].sort(
    (a, b) =>
      Number(!!b.collectionId) - Number(!!a.collectionId) ||
      Number(!!b.note) - Number(!!a.note) ||
      (b.description?.length ?? 0) - (a.description?.length ?? 0) ||
      a.createdAt.localeCompare(b.createdAt)
  )[0]
}

/** Union-find grouping by dupKey, then by same site + same normalized title. */
export function findNearDuplicates<T extends DupItem>(items: T[]): DupGroup<T>[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  const via = new Map<string, Set<'exact' | 'url' | 'title'>>()
  const mark = (id: string, k: 'exact' | 'url' | 'title') => via.set(id, (via.get(id) ?? new Set()).add(k))
  for (const t of items) parent.set(t.id, t.id)
  const byNorm = new Map<string, string>()
  const byKey = new Map<string, string>()
  const byTitle = new Map<string, string>()
  for (const t of items) {
    const n = normalizeUrl(t.url)
    const k = dupKey(t.url)
    const tk = titleKey(t.title)
    if (byNorm.has(n)) {
      union(t.id, byNorm.get(n)!)
      mark(t.id, 'exact')
    } else byNorm.set(n, t.id)
    if (byKey.has(k)) {
      if (find(t.id) !== find(byKey.get(k)!)) mark(t.id, 'url')
      union(t.id, byKey.get(k)!)
    } else byKey.set(k, t.id)
    if (tk) {
      const tkey = siteOf(t.domain) + '|' + tk
      if (byTitle.has(tkey)) {
        if (find(t.id) !== find(byTitle.get(tkey)!)) mark(t.id, 'title')
        union(t.id, byTitle.get(tkey)!)
      } else byTitle.set(tkey, t.id)
    }
  }
  const groups = new Map<string, T[]>()
  for (const t of items) {
    const r = find(t.id)
    groups.set(r, [...(groups.get(r) ?? []), t])
  }
  const out: DupGroup<T>[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const kinds = new Set(list.flatMap((t) => [...(via.get(t.id) ?? [])]))
    const kind = kinds.has('title') ? 'title' : kinds.has('url') ? 'url' : 'exact'
    const reason = kind === 'exact' ? '链接完全相同' : kind === 'url' ? '链接仅差跟踪参数 / 移动版 / 末尾斜杠' : '同站点、标题相同（内容重复）'
    out.push({ key: dupKey(list[0].url), kind, reason, items: list, keepId: pickKeep(list).id })
  }
  return out.sort((a, b) => b.items.length - a.items.length)
}
