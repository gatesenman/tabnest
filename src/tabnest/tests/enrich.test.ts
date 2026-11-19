import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '../electron/db'
import { AutoOrganizer, type OrgSettings } from '../electron/autoorg'
import { heuristicEnrich } from '../shared/ai-heuristic'
import { reviewTaxonomy, topicClusters } from '../shared/autoorg/engine'

let dir: string
let repo: Repo
let cfg: OrgSettings
let org: AutoOrganizer
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabnest-enrich-'))
  repo = new Repo(join(dir, 't.db'))
  cfg = { autoOrganize: true, autoOrganizeThreshold: 0.75, groupThreshold: 8, aiCloudOrganize: false, aiBaseUrl: 'https://x/v1', aiModel: 'm' }
  org = new AutoOrganizer(
    repo,
    () => cfg,
    () => {}
  )
})
afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('AI enrichment', () => {
  it('local engine fills description, keywords, topics, summary, lang', () => {
    const e = heuristicEnrich('React 官方文档 - 快速入门', 'https://react.dev/learn', 'react.dev')
    expect(e.description).toBeTruthy()
    expect(e.summary).toContain('React')
    expect(e.lang).toBe('zh')
    expect(Array.isArray(e.topics)).toBe(true)
  })

  it('background job persists enrichment for tabs and bookmarks, re-enriches on title change', async () => {
    const col = repo.createCollection('收藏')
    repo.insertTabs([
      { id: 'a', url: 'https://github.com/foo/bar', title: 'foo/bar', sessionId: null, collectionId: null },
      { id: 'b', url: 'https://example.com/x', title: 'Example page', sessionId: null, collectionId: col }
    ])
    expect(repo.enrichmentStats().pending).toBe(2)
    expect(await org.describeSome(50)).toBe(2)
    const [a, b] = repo.getTabs(['a', 'b'])
    expect(a.enrichedAt).toBeTruthy()
    expect(b.enrichedBy).toBe('local')
    expect(repo.enrichmentStats()).toMatchObject({ enriched: 2, pending: 0 })
    repo.updateTab('b', { title: 'Changed title' })
    expect(repo.getTabs(['b'])[0].enrichStale).toBe(true)
    expect(repo.needEnrichment(10).map((t) => t.id)).toContain('b')
  })

  it('FTS / AI search hits AI-only fields (description, keywords, topics, summary)', () => {
    repo.insertTabs([{ id: 'z', url: 'https://zz.example/p', title: 'zz', sessionId: null, collectionId: null }])
    repo.setEnrichment(
      'z',
      { description: '一款收藏夹管理工具', keywords: ['bookmark manager'], topics: ['效率工具'], summary: '整理书签的应用', lang: 'zh' },
      'cloud'
    )
    expect(repo.search('收藏夹管理').map((t) => t.id)).toContain('z')
    expect(repo.search('bookmark manager').map((t) => t.id)).toContain('z')
    const r = repo.aiSearch('有没有 收藏夹管理 的 效率工具')
    expect(r[0].tab.id).toBe('z')
    expect(r[0].matched).toEqual(expect.arrayContaining(['描述', '主题']))
  })
})

describe('dynamic regrouping', () => {
  const mk = (n: number, topic: string) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${topic}${i}`,
      url: `https://${topic}${i}.com/`,
      title: `Tool ${i}`,
      sessionId: null,
      collectionId: null
    }))

  it('≥ threshold same-topic items from different sites become one group; below threshold do not', () => {
    repo.insertTabs([...mk(10, 'bm'), ...mk(3, 'other')])
    for (let i = 0; i < 10; i++) repo.setEnrichment(`bm${i}`, { description: 'd', keywords: [], topics: ['收藏夹管理'], summary: '', lang: 'zh' }, 'local')
    const tabs = repo.snapshot().tabs
    const g = topicClusters(tabs, 8)
    expect(g.find((x) => x.name === '收藏夹管理')?.tabIds.length).toBe(10)
    expect(topicClusters(tabs, 11).find((x) => x.name === '收藏夹管理')).toBeUndefined()
    const ops = reviewTaxonomy([], tabs, { growThreshold: 8 })
    expect(ops.some((o) => o.kind === 'create' && o.name === '收藏夹管理' && o.tabIds.length === 10)).toBe(true)
  })

  it('existing bookmarks inside a mixed folder get a sub-group, logged and undoable', () => {
    const f = repo.createCollection('杂项')
    repo.insertTabs([...mk(9, 'bm'), ...mk(6, 'misc')].map((t) => ({ ...t, collectionId: f })))
    for (let i = 0; i < 9; i++) repo.setEnrichment(`bm${i}`, { description: 'd', keywords: [], topics: ['收藏夹管理'], summary: '', lang: 'zh' }, 'local')
    const ops = org.review(true)
    expect(ops.some((o) => o.kind === 'nest' && o.name === '收藏夹管理')).toBe(true)
    const sub = repo.snapshot().collections.find((c) => c.name === '收藏夹管理' && c.parentId === f)!
    expect(repo.getTabs(['bm0'])[0].collectionId).toBe(sub.id)
    const e = repo.orgLog(10).find((x) => x.kind === 'nest')!
    repo.undoOrg(e.id)
    expect(repo.getTabs(['bm0'])[0].collectionId).toBe(f)
  })
})
