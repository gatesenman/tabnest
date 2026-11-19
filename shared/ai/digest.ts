import { siteOf } from '../cluster'
import { friendlySite } from './naming'
import { isStopword } from './segment'

export interface DigestInput {
  tabs: {
    id: string
    title: string
    domain: string
    createdAt: string
    lastActiveAt: string | null
    collectionId: string | null
    topics?: string[]
    keywords: string[]
    linkStatus: string
  }[]
  readLaterId?: string | null
  organizedThisWeek: number
  duplicates: number
  now?: Date
}

export interface WeeklyDigest {
  from: string
  to: string
  added: number
  addedPrev: number
  organized: number
  topTopics: { name: string; count: number }[]
  topSites: { name: string; site: string; count: number }[]
  stale: { kind: 'readLater' | 'unsorted' | 'dead' | 'dup'; label: string; count: number; ids: string[] }[]
}

const DAY = 86400000
const GENERIC = /^(网页|网站|页面|文章|首页|工具|链接|视频|官网|web|page|site|home|docs?|blog|github|搜索|文档)$/i

/** Weekly AI digest for 概览: what was collected, its main topics, and what has gone stale. Compact, no scores. */
export function weeklyDigest(i: DigestInput): WeeklyDigest {
  const now = (i.now ?? new Date()).getTime()
  const from = now - 7 * DAY
  const prev = now - 14 * DAY
  const week = i.tabs.filter((t) => Date.parse(t.createdAt) >= from)
  const topicN = new Map<string, { name: string; count: number }>()
  for (const t of week)
    for (const k of new Set([...(t.topics ?? []), ...t.keywords.slice(0, 4)])) {
      const key = k.toLowerCase()
      if ([...k].length < 2 || GENERIC.test(k) || isStopword(k)) continue
      const cur = topicN.get(key) ?? { name: k, count: 0 }
      cur.count++
      topicN.set(key, cur)
    }
  const siteN = new Map<string, number>()
  for (const t of week) siteN.set(siteOf(t.domain), (siteN.get(siteOf(t.domain)) ?? 0) + 1)
  const seen = (t: DigestInput['tabs'][number]) => Date.parse(t.lastActiveAt ?? t.createdAt)
  const readLater = i.readLaterId ? i.tabs.filter((t) => t.collectionId === i.readLaterId && now - seen(t) > 14 * DAY) : []
  const unsorted = i.tabs.filter((t) => !t.collectionId && now - seen(t) > 30 * DAY)
  const dead = i.tabs.filter((t) => t.linkStatus === 'broken')
  const stale: WeeklyDigest['stale'] = []
  if (readLater.length) stale.push({ kind: 'readLater', label: '稍后阅读里超过 2 周没看', count: readLater.length, ids: readLater.map((t) => t.id) })
  if (unsorted.length) stale.push({ kind: 'unsorted', label: '未整理且 30 天没再打开', count: unsorted.length, ids: unsorted.map((t) => t.id) })
  if (dead.length) stale.push({ kind: 'dead', label: '链接已失效', count: dead.length, ids: dead.map((t) => t.id) })
  if (i.duplicates) stale.push({ kind: 'dup', label: '组重复 / 近似重复', count: i.duplicates, ids: [] })
  return {
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    added: week.length,
    addedPrev: i.tabs.filter((t) => Date.parse(t.createdAt) >= prev && Date.parse(t.createdAt) < from).length,
    organized: i.organizedThisWeek,
    topTopics: [...topicN.values()]
      .filter((x) => x.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    topSites: [...siteN]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([site, count]) => ({ site, name: friendlySite(site), count })),
    stale
  }
}
