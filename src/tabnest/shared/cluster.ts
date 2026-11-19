import { tokenize } from './ai-heuristic'
import type { TabItem } from './types'

export interface ClusterSuggestion {
  id: string
  kind: 'domain' | 'topic'
  label: string
  folderName: string
  tabIds: string[]
}

const SECOND_LEVEL = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac'])
/** github.com / docs.github.com → github.com; news.sina.com.cn → sina.com.cn */
export function siteOf(domain: string): string {
  const parts = domain
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const n = SECOND_LEVEL.has(parts.at(-2)!) && parts.at(-1)!.length === 2 ? 3 : 2
  return parts.slice(-n).join('.')
}

const GENERIC = new Set(['首页', 'home', 'index', 'search', 'login', 'page', 'html', 'php', 'app', 'docs', 'the', 'and', 'for', 'with', 'new', '官网', '官方'])

/**
 * Local heuristic clustering for hundreds of unsorted tabs:
 * 1) same site with ≥ minSize tabs → a site group; 2) leftovers grouped by the most shared title/path keyword.
 */
export function suggestClusters(tabs: TabItem[], minSize = 3, maxGroups = 30): ClusterSuggestion[] {
  const out: ClusterSuggestion[] = []
  const bySite = new Map<string, TabItem[]>()
  for (const t of tabs) {
    const s = siteOf(t.domain || '')
    if (!s) continue
    bySite.set(s, [...(bySite.get(s) ?? []), t])
  }
  const used = new Set<string>()
  for (const [site, list] of [...bySite].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < minSize) continue
    out.push({ id: `site:${site}`, kind: 'domain', label: `${site}（${list.length}）`, folderName: site, tabIds: list.map((t) => t.id) })
    list.forEach((t) => used.add(t.id))
  }
  let rest = tabs.filter((t) => !used.has(t.id))
  const tokensOf = new Map(
    rest.map((t) => [
      t.id,
      tokenize(t.title, t.url)
        .map((x) => x.toLowerCase())
        .filter((x) => !GENERIC.has(x) && x.length >= 2)
    ])
  )
  for (;;) {
    const freq = new Map<string, number>()
    for (const t of rest) for (const k of new Set(tokensOf.get(t.id))) freq.set(k, (freq.get(k) ?? 0) + 1)
    const top = [...freq].filter(([, n]) => n >= minSize).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    if (!top || out.length >= maxGroups) break
    const members = rest.filter((t) => tokensOf.get(t.id)!.includes(top[0]))
    const pretty = rest.flatMap((t) => tokenize(t.title, t.url)).find((x) => x.toLowerCase() === top[0]) ?? top[0]
    out.push({ id: `topic:${top[0]}`, kind: 'topic', label: `主题：${pretty}（${members.length}）`, folderName: pretty, tabIds: members.map((t) => t.id) })
    const ids = new Set(members.map((t) => t.id))
    rest = rest.filter((t) => !ids.has(t.id))
  }
  return out.slice(0, maxGroups)
}
