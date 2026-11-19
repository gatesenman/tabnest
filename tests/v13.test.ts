import { describe, expect, it } from 'vitest'
import { reconcile } from '../shared/reconcile'
import { buildLifecycle } from '../shared/lifecycle'
import { suggestClusters, siteOf } from '../shared/cluster'
import type { Collection, Session, SnapshotItem, TabItem } from '../shared/types'

const tab = (id: string, p: Partial<TabItem> = {}): TabItem => ({
  id,
  sessionId: null,
  collectionId: null,
  title: id,
  url: `https://x.com/${id}`,
  normUrl: `x.com/${id}`,
  domain: 'x.com',
  favicon: '',
  createdAt: '2026-10-01T00:00:00Z',
  groupName: null,
  description: '',
  keywords: [],
  linkStatus: 'unknown',
  linkStatusCode: null,
  linkStatusNote: null,
  lastCheckedAt: null,
  browserId: 'edge',
  profileId: 'Default',
  pinned: false,
  lastActiveAt: null,
  note: '',
  organizedAt: null,
  ...p
})
const day = (id: string, d: string): Session => ({
  id,
  name: d,
  createdAt: d,
  note: '',
  tags: [],
  groupNames: {},
  kind: 'daily',
  sourceSummary: '',
  addedCount: 0,
  removedCount: 0,
  day: d,
  itemCount: 0
})
const item = (sessionId: string, tabId: string): SnapshotItem => ({
  sessionId,
  tabId,
  title: tabId,
  firstSeenAt: '',
  lastSeenAt: '',
  seenCount: 1,
  sources: []
})

describe('reconciliation', () => {
  const base = {
    browserId: 'edge',
    name: 'Edge',
    running: true,
    locked: true,
    stale: true,
    archiveAt: '2026-10-14T15:01:00Z',
    rawTabs: 380,
    filtered: 6,
    deduped: 366,
    inToday: 366
  }
  it('explains a locked Edge archive and offers close-this fix', () => {
    const r = reconcile(base, Date.parse('2026-10-14T16:00:00Z'))
    expect(r.best).toBe(366)
    expect(r.freshness).toBe('old')
    expect(r.fixes).toEqual(expect.arrayContaining(['closeThis']))
    expect(r.fixes).not.toContain('installExtension')
    expect(r.reasons.join()).toMatch(/锁定/)
    expect(r.reasons.join()).toMatch(/过滤了 6/)
    expect(r.reasons.join()).toMatch(/8 个是重复/)
    expect(r.reasons.join()).toMatch(/只快照并关闭/)
  })
  it('flags unsnapshotted tabs against archive count', () => {
    const r = reconcile({ ...base, locked: false, stale: false, archiveAt: '2026-10-14T15:59:00Z', inToday: 360 }, Date.parse('2026-10-14T16:00:00Z'))
    expect(r.best).toBe(366)
    expect(r.source).toBe('archive')
    expect(r.fixes).toEqual(['snapshotNow'])
  })
  it('fresh unlocked archive with nothing to fix', () => {
    const r = reconcile(
      { ...base, name: 'Opera', locked: false, stale: false, archiveAt: '2026-10-14T15:58:00Z', rawTabs: 20, filtered: 0, deduped: 20, inToday: 20 },
      Date.parse('2026-10-14T16:00:00Z')
    )
    expect(r.freshness).toBe('fresh')
    expect(r.fixes).toEqual([])
    expect(r.reasons).toEqual(['数字一致，无需处理。'])
  })
})

describe('lifecycle', () => {
  const sessions = [day('d1', '2026-10-12'), day('d2', '2026-10-13'), day('d3', '2026-10-14')]
  const cols: Collection[] = [
    { id: 'arc', name: '归档', builtin: true, parentId: null, createdAt: '', note: '', sort: 0 },
    { id: 'w', name: '工作', builtin: true, parentId: null, createdAt: '', note: '', sort: 1 }
  ]
  const tabs = [tab('new'), tab('ongoing'), tab('gone'), tab('old'), tab('kept', { collectionId: 'w' }), tab('arch', { collectionId: 'arc' })]
  const items = [item('d3', 'new'), item('d2', 'ongoing'), item('d3', 'ongoing'), item('d2', 'gone'), item('d1', 'old'), item('d2', 'kept')]
  const lc = buildLifecycle(tabs, sessions, items, cols)
  it('classifies tabs', () => {
    expect(Object.fromEntries(lc.status)).toEqual({ new: 'new', ongoing: 'ongoing', gone: 'closed', old: 'closed', kept: 'organized', arch: 'archived' })
    expect(lc.latestDay).toBe('2026-10-14')
  })
  it('lists tabs that disappeared since the previous day (not organized ones)', () => {
    expect(lc.disappeared).toEqual(['gone'])
  })
})

describe('clustering', () => {
  it('siteOf collapses subdomains and ccSLDs', () => {
    expect(siteOf('docs.github.com')).toBe('github.com')
    expect(siteOf('news.sina.com.cn')).toBe('sina.com.cn')
  })
  it('groups by site, then by shared keyword', () => {
    const tabs = [
      ...['a', 'b', 'c'].map((i) => tab(`gh${i}`, { domain: i === 'a' ? 'github.com' : 'gist.github.com' })),
      tab('r1', { title: 'React hooks guide', domain: 'a.dev' }),
      tab('r2', { title: 'React 性能优化', domain: 'b.dev' }),
      tab('r3', { title: 'Learning React', domain: 'c.dev' }),
      tab('z', { title: 'Weather', domain: 'w.com' })
    ]
    const g = suggestClusters(tabs)
    expect(g[0]).toMatchObject({ kind: 'domain', folderName: 'github.com' })
    expect(g[0].tabIds).toHaveLength(3)
    expect(g[1]).toMatchObject({ kind: 'topic', folderName: 'React' })
    expect(g[1].tabIds.sort()).toEqual(['r1', 'r2', 'r3'])
    expect(g).toHaveLength(2)
  })
})

import { classify, learnRules, reviewTaxonomy, distinctiveToken, type FolderInfo } from '../shared/autoorg/engine'
import { SITE_COUNT } from '../shared/autoorg/sites'

describe('auto-organize: classifier', () => {
  it('has a ~300 site knowledge table', () => expect(SITE_COUNT).toBeGreaterThanOrEqual(290))
  it('classifies by site table with subdomain + path awareness', () => {
    expect(classify(tab('a', { url: 'https://github.com/x/y', domain: 'github.com', title: 'x/y' }))).toMatchObject({
      folderPath: '开发/代码托管',
      engine: 'table'
    })
    expect(classify(tab('b', { url: 'https://gist.github.com/1', domain: 'gist.github.com' }))?.confidence).toBeGreaterThanOrEqual(0.85)
    expect(classify(tab('c', { url: 'https://www.bilibili.com/video/BV1', domain: 'bilibili.com' }))?.folderPath).toBe('视频')
    expect(classify(tab('d', { url: 'https://www.zhihu.com/question/1', domain: 'zhihu.com' }))).toMatchObject({ folderPath: '学习/百科' })
  })
  it('falls back to low-confidence keywords, or null', () => {
    const k = classify(tab('e', { url: 'https://foo.example/p', domain: 'foo.example', title: '大模型 RAG 入门' }))
    expect(k?.engine).toBe('keyword')
    expect(k!.confidence).toBeLessThan(0.75)
    expect(classify(tab('f', { url: 'https://zzz.example/', domain: 'zzz.example', title: 'hello' }))).toBeNull()
  })
})

describe('auto-organize: rule learning', () => {
  it('a correction becomes a domain rule that wins over the site table', () => {
    const t = tab('g', { url: 'https://github.com/acme/app', domain: 'github.com', title: 'acme app' })
    const rules = learnRules([], [t], 'work')
    expect(rules).toMatchObject([{ kind: 'domain', match: 'github.com', folderId: 'work' }])
    expect(classify(tab('h', { url: 'https://github.com/other', domain: 'github.com' }), rules)).toMatchObject({ folderId: 'work', engine: 'rule' })
    const again = learnRules(rules, [t], 'learn')
    expect(again.filter((r) => r.match === 'github.com')).toHaveLength(1)
    expect(again[0].folderId).toBe('learn')
  })
  it('learns keyword rules from multi-site batches', () => {
    const r = learnRules(
      [],
      [tab('i', { url: 'https://a.io/', domain: 'a.io', title: 'Tauri guide' }), tab('j', { url: 'https://b.io/', domain: 'b.io', title: 'Tauri plugin' })],
      'tauri'
    )
    expect(r.some((x) => x.kind === 'keyword' && x.match === 'tauri')).toBe(true)
    expect(classify(tab('k', { url: 'https://c.io/', domain: 'c.io', title: 'tauri release' }), r)?.folderId).toBe('tauri')
  })
})

describe('auto-organize: taxonomy review (create / merge / rename / split)', () => {
  const f = (id: string, name: string, tabs: TabItem[], p: Partial<FolderInfo> = {}): FolderInfo => ({
    id,
    name,
    parentId: null,
    builtin: false,
    tabs,
    childCount: 0,
    ...p
  })
  it('creates a folder when an unsorted cluster grows past 8', () => {
    const unsorted = Array.from({ length: 9 }, (_, i) => tab(`u${i}`, { url: `https://x${i}.dev/`, domain: `x${i}.dev`, title: `Svelte tip ${i}` }))
    const ops = reviewTaxonomy([], unsorted)
    expect(ops).toEqual([expect.objectContaining({ kind: 'create', tabIds: expect.arrayContaining(['u0', 'u8']) })])
    expect(reviewTaxonomy([], unsorted.slice(0, 8))).toEqual([])
    expect(distinctiveToken(unsorted, unsorted)).toBe('svelte')
  })
  it('merges a near-empty folder into a similar sibling', () => {
    const gh = (i: number) => tab(`g${i}`, { url: `https://github.com/r${i}`, domain: 'github.com' })
    const ops = reviewTaxonomy([f('a', '代码', [gh(1), gh(2), gh(3)]), f('b', '代码仓库', [gh(4)])], [])
    expect(ops).toContainEqual(expect.objectContaining({ kind: 'merge', fromId: 'b', intoId: 'a' }))
  })
  it('renames vague folders after their dominant category', () => {
    const v = (i: number) => tab(`v${i}`, { url: `https://www.bilibili.com/video/${i}`, domain: 'bilibili.com' })
    expect(reviewTaxonomy([f('n', '新建文件夹 (2)', [v(1), v(2), v(3)])], [])).toContainEqual(expect.objectContaining({ kind: 'rename', id: 'n', to: '视频' }))
  })
  it('splits a large mixed folder into per-site subfolders', () => {
    const mk = (d: string, n: number) => Array.from({ length: n }, (_, i) => tab(`${d}${i}`, { url: `https://${d}/${i}`, domain: d }))
    const ops = reviewTaxonomy([f('big', '工作', [...mk('github.com', 6), ...mk('notion.so', 6)], { builtin: true })], [])
    expect(
      ops
        .filter((o) => o.kind === 'nest')
        .map((o) => (o as { name: string }).name)
        .sort()
    ).toEqual(['GitHub', 'Notion']) // 1.4: friendly site names instead of raw domains
  })
})
