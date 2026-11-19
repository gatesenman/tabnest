import type { LinkStatus, TabItem } from '../shared/types'

export function statusLabel(s: LinkStatus): string {
  return { ok: '有效', redirect: '重定向', broken: '失效', timeout: '超时', checking: '检查中…', unknown: '未检查' }[s]
}
export function statusClass(s: LinkStatus): string {
  return `status-${s}`
}

/** Case-insensitive match over title / url / domain / description / keywords. */
export function matches(t: TabItem, q: string): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  return (
    t.title.toLowerCase().includes(s) ||
    t.url.toLowerCase().includes(s) ||
    t.domain.includes(s) ||
    t.description.toLowerCase().includes(s) ||
    t.keywords.some((k) => k.toLowerCase().includes(s))
  )
}

export function groupByKey(tabs: TabItem[], key: (t: TabItem) => string): [string, TabItem[]][] {
  const m = new Map<string, TabItem[]>()
  for (const t of tabs) {
    const k = key(t)
    const arr = m.get(k)
    if (arr) arr.push(t)
    else m.set(k, [t])
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('zh-CN')
