import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '../electron/db'
import { AutoOrganizer, type OrgSettings } from '../electron/autoorg'
import { segment, extractKeywords } from '../shared/ai/segment'
import { extractPage, pageSnippet, sniffCharset } from '../shared/ai/extract'
import { enrichLocal } from '../shared/ai/enrich-local'
import { dupKey, findNearDuplicates, titleKey } from '../shared/ai/dedupe'
import { parseNlQuery } from '../shared/ai/nlquery'
import { isVagueName, nameFolder } from '../shared/ai/naming'
import { classify, reviewTaxonomy } from '../shared/autoorg/engine'
import { embedLocal } from '../shared/ai/vector'
import { weeklyDigest } from '../shared/ai/digest'
import { CloudAI, CloudError, estimateTokens, type UsageStore } from '../electron/ai/cloud'
import { canFetch, fetchPage } from '../electron/ai/fetchpage'
import { evaluate } from './classifier-eval'
import type { TabItem } from '../shared/types'

let dir: string
let repo: Repo
let cfg: OrgSettings
let org: AutoOrganizer
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabnest-ai140-'))
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

const tab = (id: string, p: Partial<TabItem> = {}): TabItem =>
  ({
    id,
    title: id,
    url: `https://${id}.example/`,
    domain: `${id}.example`,
    keywords: [],
    topics: [],
    collectionId: null,
    createdAt: new Date().toISOString(),
    ...p
  }) as TabItem

describe('segmentation & keywords (CN + EN)', () => {
  it('segments Chinese with dictionary max-match and bigram fallback, drops stopwords', () => {
    const t = segment('大语言模型的提示词工程入门教程')
    expect(t).toEqual(expect.arrayContaining(['大语言模型', '提示词', '入门', '教程']))
    expect(t).not.toContain('的')
  })
  it('splits camelCase, keeps c++/node.js, light stemming, drops stopwords / hashes', () => {
    const t = segment('useEffect hooks for the React Components c++ node.js 9f8e7d6c5b4a')
    expect(t).toEqual(expect.arrayContaining(['useeffect', 'effect', 'hook', 'react', 'component', 'c++', 'node.js']))
    expect(t).not.toContain('the')
    expect(t.some((x) => x.startsWith('9f8e'))).toBe(false)
  })
  it('extracts meaningful keywords from page fields, preferring title casing', () => {
    const k = extractKeywords(
      [
        { text: 'Raindrop.io — All-in-one bookmark manager', weight: 3 },
        { text: '书签管理工具，帮你整理收藏夹和网页', weight: 2 }
      ],
      8
    )
    expect(k.map((x) => x.toLowerCase())).toEqual(expect.arrayContaining(['bookmark', '书签管理', '收藏夹']))
    expect(k).not.toContain('one')
  })
})

describe('page extraction', () => {
  const html = `<html lang="zh-CN"><head><meta charset="gbk"><title>Pinia | Vue 状态管理</title>
    <meta name="description" content="类型安全、可扩展的 Vue 状态管理库">
    <meta property="og:title" content="Pinia 官方文档"><meta name="keywords" content="vue,状态管理,pinia">
    <script>var x = '<h1>bad</h1>'</script><style>h1{}</style></head>
    <body><nav><p>导航导航导航导航导航导航导航导航导航导航导航导航导航导航导航导航</p></nav><main><h1>介绍</h1><h2>为什么使用 Pinia</h2>
    <p>Pinia 是 Vue 的专属状态管理库，它允许你跨组件或页面共享状态，支持组合式 API 与选项式 API。</p></main></body></html>`
  it('uses title, meta, og, h1-h3 and first paragraphs; ignores scripts and nav', () => {
    const p = extractPage(html)
    expect(p.title).toBe('Pinia | Vue 状态管理')
    expect(p.description).toContain('状态管理库')
    expect(p.ogTitle).toBe('Pinia 官方文档')
    expect(p.metaKeywords).toEqual(['vue', '状态管理', 'pinia'])
    expect(p.headings).toEqual(['介绍', '为什么使用 Pinia'])
    expect(p.headings).not.toContain('bad')
    expect(p.paragraphs[0]).toContain('专属状态管理库')
    expect(p.paragraphs.join('')).not.toContain('导航')
    expect(p.lang).toBe('zh-cn')
    const snip = pageSnippet(p)
    expect(snip).not.toMatch(/<|>/)
    expect(snip.length).toBeLessThanOrEqual(1200)
  })
  it('maps GBK / GB2312 to gb18030 for decoding', () => {
    expect(sniffCharset('text/html; charset=GB2312', '')).toBe('gb18030')
    expect(sniffCharset(null, '<meta charset="utf-8">')).toBe('utf-8')
  })
  it('content-aware enrichment beats title-only for an unknown site', () => {
    const p = extractPage(html)
    const e = enrichLocal('Pinia', 'https://pinia.vuejs.org/zh/', 'pinia.vuejs.org', p)
    expect(e.keywords.join(' ')).toMatch(/状态管理/)
    expect(e.description).toContain('状态管理库')
    expect(e.content).toContain('Pinia')
  })
})

describe('page fetch (mocked network)', () => {
  const res = (body: string, ct = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': ct } })
  it('refuses private hosts, login apps and binaries', () => {
    expect(canFetch('http://127.0.0.1/x')).toBe(false)
    expect(canFetch('http://192.168.1.2/')).toBe(false)
    expect(canFetch('https://mail.google.com/')).toBe(false)
    expect(canFetch('https://x.com/a.pdf')).toBe(false)
    expect(canFetch('https://react.dev/learn')).toBe(true)
  })
  it('extracts html, skips non-html, caps size, reports http errors', async () => {
    const ok = await fetchPage('https://a.dev/', { fetchImpl: async () => res('<title>Hi</title><meta name="description" content="d">') })
    expect(ok.ok && ok.page.title).toBe('Hi')
    expect(await fetchPage('https://a.dev/', { fetchImpl: async () => res('{}', 'application/json') })).toEqual({ ok: false, status: 'not-html' })
    expect(await fetchPage('https://a.dev/', { fetchImpl: async () => res('', 'text/html', 404) })).toEqual({ ok: false, status: 'http 404', code: 404 })
    const big = await fetchPage('https://a.dev/', { maxBytes: 1000, fetchImpl: async () => res('<title>T</title>' + 'x'.repeat(100000)) })
    expect(big.ok).toBe(true)
    const err = await fetchPage('https://a.dev/', {
      fetchImpl: async () => {
        throw new Error('boom')
      }
    })
    expect(err).toEqual({ ok: false, status: 'boom' })
  })
})

describe('URL normalization & near-duplicates', () => {
  it('dupKey ignores tracking/share params, www/m., trailing slash, index.html, plain hash; keeps hash routes', () => {
    const k = dupKey('https://www.example.com/a/')
    expect(dupKey('http://m.example.com/a?utm_source=x&spm=1.2')).toBe(k)
    expect(dupKey('https://example.com/a/index.html#top')).toBe(k)
    expect(dupKey('https://www.bilibili.com/video/BV1?vd_source=abc&share_source=copy')).toBe(dupKey('https://m.bilibili.com/video/BV1'))
    expect(dupKey('https://app.example.com/#/settings')).not.toBe(dupKey('https://app.example.com/#/home'))
    expect(dupKey('https://example.com/a?id=1')).not.toBe(dupKey('https://example.com/a?id=2'))
  })
  it('groups by url key and same-site same-title; keeps organized item', () => {
    const items = [
      { id: '1', url: 'https://example.com/p?utm_source=a', title: 'P', domain: 'example.com', collectionId: null, createdAt: '2026-01-01' },
      { id: '2', url: 'https://m.example.com/p/', title: 'P', domain: 'm.example.com', collectionId: 'c', createdAt: '2026-01-02' },
      {
        id: '3',
        url: 'https://news.site.com/a/1',
        title: '重大新闻：某某发布新品发布会全记录',
        domain: 'news.site.com',
        collectionId: null,
        createdAt: '2026-01-01'
      },
      {
        id: '4',
        url: 'https://news.site.com/a/1?from=wx',
        title: '重大新闻：某某发布新品发布会全记录',
        domain: 'news.site.com',
        collectionId: null,
        createdAt: '2026-01-01'
      },
      {
        id: '5',
        url: 'https://www.site.com/b/2',
        title: '重大新闻：某某发布新品发布会全记录',
        domain: 'site.com',
        collectionId: null,
        createdAt: '2026-01-03'
      },
      { id: '6', url: 'https://other.com/', title: 'Home', domain: 'other.com', collectionId: null, createdAt: '2026-01-01' }
    ]
    const g = findNearDuplicates(items)
    expect(g).toHaveLength(2)
    const a = g.find((x) => x.items.some((i) => i.id === '1'))!
    expect(a.keepId).toBe('2')
    expect(a.kind).toBe('url')
    const b = g.find((x) => x.items.some((i) => i.id === '3'))!
    expect(b.items.map((i) => i.id).sort()).toEqual(['3', '4', '5'])
    expect(b.kind).toBe('title')
    expect(titleKey('Home')).toBe('')
  })
  it('one-click merge moves extras to the recycle bin, kept item absorbs metadata; undo restores everything', () => {
    const col = repo.createCollection('工作区')
    repo.insertTabs([
      { id: 'a', url: 'https://example.com/p?utm_source=x', title: 'Page', sessionId: null, collectionId: null },
      { id: 'b', url: 'https://m.example.com/p/', title: 'Page', sessionId: null, collectionId: col },
      { id: 'c', url: 'https://example.com/other', title: 'Other', sessionId: null, collectionId: null }
    ])
    repo.updateTab('a', { note: '我的备注' })
    const r = org.mergeDuplicates()
    expect(r).toMatchObject({ groups: 1, removed: 1 })
    expect(repo.getTabs(['a'])).toHaveLength(0)
    expect(repo.trashList().map((t) => t.id)).toContain('a')
    const kept = repo.getTabs(['b'])[0]
    expect(kept.note).toContain('我的备注')
    expect(org.undo(r.logId!)).toBe(true)
    expect(repo.getTabs(['a'])[0].note).toBe('我的备注')
    expect(repo.getTabs(['b'])[0].note).toBe('')
    expect(repo.trashList()).toHaveLength(0)
  })
})

describe('classifier: accuracy on labeled fixture (~150 CN/EN URLs)', () => {
  it('content-aware hybrid classifier beats the 1.3.5 engine by a wide margin and is calibrated', () => {
    const r = evaluate()
    expect(r.rows.length).toBeGreaterThanOrEqual(140)
    expect(r.after).toBeGreaterThanOrEqual(0.88)
    expect(r.after - r.before).toBeGreaterThanOrEqual(0.15)
    expect(r.afterKnn).toBeGreaterThanOrEqual(0.88)
    const hi = r.calib.find((b) => b.bin.startsWith('0.9'))!
    expect(hi.acc).toBeGreaterThanOrEqual(0.95) // ≥90% confidence must be right ≥95% of the time
  })
  it('explains every decision', () => {
    const c = classify({ url: 'https://github.com/facebook/react', domain: 'github.com', title: 'facebook/react', keywords: ['react'], topics: [] })!
    expect(c.reason).toMatch(/^依据：域名 github\.com → 代码托管/)
    expect(c.basis!.length).toBeGreaterThanOrEqual(1)
  })
  it('kNN similarity steers unknown sites into the user’s own folders', () => {
    const v = (title: string, kw: string[]) => embedLocal({ title, keywords: kw })
    const ex = [
      { folderId: 'shop', path: '电商运营', vec: v('Shopify 独立站 选品 运营', ['选品', '独立站', 'shopify']), size: 5 },
      { folderId: 'ai', path: 'AI 工具', vec: v('LLM chatbot 大模型', ['大模型', 'llm']), size: 5 }
    ]
    const t = { url: 'https://unknown-seller-tool.io/', domain: 'unknown-seller-tool.io', title: '独立站选品工具', keywords: ['选品', '独立站'], topics: [] }
    const c = classify(t, [], { vec: v(t.title, t.keywords), exemplars: ex })!
    expect(c.folderId).toBe('shop')
    expect(c.reason).toContain('相似')
  })
})

describe('natural-language query parser', () => {
  const now = new Date(2026, 9, 20, 10) // Tue 2026-10-20
  it('parses time, browser, site, status and keeps the topic terms', () => {
    const q = parseNlQuery('上周在 Edge 打开的 react 文档', { now })
    expect(q.chips).toEqual([
      { kind: 'time', label: '上周' },
      { kind: 'browser', label: 'Edge' }
    ])
    expect(new Date(q.from!).getDate()).toBe(12)
    expect(new Date(q.to!).getDate()).toBe(19)
    expect(q.terms).toEqual(expect.arrayContaining(['react', '文档']))
    expect(parseNlQuery('昨天 B站上的视频', { now })).toMatchObject({ site: 'bilibili.com', terms: ['视频'] })
    expect(parseNlQuery('本月未整理的 github 项目', { now })).toMatchObject({ status: 'unsorted', terms: ['github', '项目'] })
    expect(parseNlQuery('最近3天 失效链接', { now }).status).toBe('dead')
    expect(parseNlQuery('2026-10-01 的笔记', { now }).chips[0].label).toBe('2026-10-01')
    expect(parseNlQuery('10月3日 看的电商运营', { now }).chips[0].label).toBe('10月3日')
    expect(parseNlQuery('site:zhihu.com 大模型', { now })).toMatchObject({ site: 'zhihu.com', terms: ['大模型'] })
  })
  it('recognizes folders and questions', () => {
    const q = parseNlQuery('工作收藏夹里的周报', { now, folders: [{ id: 'w', name: '工作' }] })
    expect(q.folder).toBe('w')
    expect(q.terms).toContain('周报')
    expect(parseNlQuery('我收藏过哪些订书签管理工具', { now }).question).toBe(true)
  })
})

describe('hybrid ranking (FTS bm25 + lexical + vectors)', () => {
  const put = (id: string, title: string, url: string, e: { description?: string; keywords?: string[]; topics?: string[] }, extra: Partial<TabItem> = {}) => {
    repo.insertTabs([{ id, title, url, sessionId: null, collectionId: null, ...extra }])
    repo.setEnrichment(id, { description: e.description ?? '', keywords: e.keywords ?? [], topics: e.topics ?? [], summary: '', lang: 'zh' }, 'local')
    repo.ai.setAiData(id, { vec: embedLocal({ title, keywords: e.keywords, topics: e.topics }), content: e.description ?? '', fetchStatus: 'ok' })
  }
  it('ranks by meaning across fields and applies parsed filters', () => {
    put('rd', 'Raindrop.io', 'https://raindrop.io/', { description: 'All-in-one bookmark manager', keywords: ['书签管理', 'bookmark'], topics: ['在线工具'] })
    put('ot', 'OneTab', 'https://onetab.com/', { description: '标签页管理扩展', keywords: ['标签页', '书签'] }, { browserId: 'edge' })
    put('gh', 'facebook/react', 'https://github.com/facebook/react', { keywords: ['React', '前端'] })
    put('bl', '某 UP 主视频', 'https://www.bilibili.com/video/BV1', { keywords: ['视频'] })
    const r = repo.ai.smartSearch('我收藏过哪些订书签管理工具')
    expect(r.items[0].id).toBe('rd')
    expect(r.items.map((x) => x.id)).toContain('ot')
    expect(r.items.map((x) => x.id)).not.toContain('gh')
    expect(r.items[0].matched.length).toBeGreaterThan(0)
    const e = repo.ai.smartSearch('Edge 里的书签')
    expect(e.chips[0]).toEqual({ kind: 'browser', label: 'Edge' })
    expect(e.items.map((x) => x.id)).toEqual(['ot'])
    expect(repo.ai.smartSearch('B站上的').items.map((x) => x.id)).toEqual(['bl'])
    const old = new Date(Date.now() - 40 * 86400000).toISOString()
    repo.db.prepare('UPDATE tabs SET created_at = ? WHERE id = ?').run(old, 'gh')
    expect(repo.ai.smartSearch('今天 react').items.map((x) => x.id)).not.toContain('gh')
  })
  it('stays fast on ~5k items (<150 ms warm)', () => {
    const words = ['react', '前端', '大模型', '电商', '选品', '视频', '书签', '设计', '论文', '股票', 'python', 'docker', '旅行', '美食', '游戏']
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: `t${i}`,
      title: `${words[i % words.length]} 相关页面 ${i} ${words[(i * 7) % words.length]}`,
      url: `https://site${i % 300}.com/p/${i}`,
      sessionId: null,
      collectionId: null,
      description: `关于${words[(i * 3) % words.length]}的介绍`,
      keywords: [words[i % words.length], words[(i * 5) % words.length]]
    }))
    repo.insertTabs(rows)
    const st = repo.db.prepare('INSERT INTO tab_ai (tab_id, content, vec, fetch_status) VALUES (?, ?, ?, ?)')
    repo.db.transaction(() =>
      rows.forEach((r) => st.run(r.id, r.description, Buffer.from(embedLocal({ title: r.title, keywords: r.keywords }).buffer), 'ok'))
    )()
    const t0 = performance.now()
    repo.ai.smartSearch('上周 react 前端')
    const cold = performance.now() - t0
    const times: number[] = []
    for (const q of ['大模型 论文', '我收藏过哪些电商选品工具', 'python docker 部署', '最近7天 视频', '设计 素材']) {
      const t = performance.now()
      const r = repo.ai.smartSearch(q)
      times.push(performance.now() - t)
      expect(r.ms).toBeLessThan(150)
    }
    console.log(
      `smartSearch 5k: cold ${cold.toFixed(0)} ms, warm max ${Math.max(...times).toFixed(1)} ms, avg ${(times.reduce((a, b) => a + b) / times.length).toFixed(1)} ms`
    )
    expect(Math.max(...times)).toBeLessThan(150)
    expect(cold).toBeLessThan(2000)
  })
})

describe('folder naming', () => {
  it('maps raw tokens to short Chinese-first concepts; rejects vague names', () => {
    expect(nameFolder({ terms: ['grok', 'chatgpt'] })).toBe('AI 工具')
    expect(nameFolder({ terms: ['products', 'shopify', '选品'] })).toBe('电商运营')
    expect(nameFolder({ terms: ['products', 'pages'] })).toBeNull()
    expect(nameFolder({ terms: [], site: { site: 'github.com', share: 0.9 } })).toBe('GitHub')
    expect(isVagueName('grok')).toBe(true)
    expect(isVagueName('products')).toBe(true)
    expect(isVagueName('github.com')).toBe(true)
    expect(isVagueName('AI 工具')).toBe(false)
    expect(isVagueName('GitHub')).toBe(false)
  })
  it('new topic groups get meaningful names, never raw tokens', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      tab(`g${i}`, { domain: `ai${i}.com`, url: `https://ai${i}.com/`, keywords: ['grok', 'products'], topics: [] })
    )
    const ops = reviewTaxonomy([], items, { growThreshold: 8 })
    const names = ops.filter((o) => o.kind === 'create').map((o) => (o as { name: string }).name)
    expect(names).toContain('AI 工具')
    expect(names).not.toContain('grok')
    expect(names).not.toContain('products')
  })
  it('upgrade renames earlier auto-created vague folders once (logged, undoable)', () => {
    const f = repo.createCollection('grok', '智能整理：9 个同类网址')
    const mine = repo.createCollection('products', '我自己建的')
    repo.insertTabs(
      Array.from({ length: 4 }, (_, i) => ({
        id: `x${i}`,
        url: `https://x${i}.ai/`,
        title: `chat ${i}`,
        sessionId: null,
        collectionId: f,
        keywords: ['grok', 'chatgpt']
      }))
    )
    repo.insertTabs([{ id: 'm1', url: 'https://m.com/', title: 'm', sessionId: null, collectionId: mine, keywords: ['grok'] }])
    expect(org.upgradeFolderNames()).toBe(1)
    expect(repo.collectionRow(f)!.name).toBe('AI 工具')
    expect(repo.collectionRow(mine)!.name).toBe('products') // user folders untouched
    expect(org.upgradeFolderNames()).toBe(0) // once
    const e = repo.orgLog(5).find((x) => x.kind === 'rename')!
    expect(org.undo(e.id)).toBe(true)
    expect(repo.collectionRow(f)!.name).toBe('grok')
  })
})

describe('content-aware background enrichment', () => {
  it('stores page text + vector, cloud receives the extracted snippet only (never HTML)', async () => {
    repo.insertTabs([{ id: 'p', url: 'https://pinia.vuejs.org/', title: 'Pinia', sessionId: null, collectionId: null }])
    cfg.aiFetchPages = true
    cfg.aiCloudOrganize = true
    let sent = ''
    org.hooks = {
      pipeline: async (jobs) => {
        const { runEnrichJobs } = await import('../electron/ai/pipeline')
        const out = await runEnrichJobs(jobs, { fetch: false })
        return out.map((o) => ({ ...o, fetchStatus: 'ok', e: { ...o.e, content: '类型安全的 Vue 状态管理库' } }))
      },
      enrichBatch: async (items) => {
        sent = items[0].snippet
        return new Map([['p', { topics: ['前端开发'], summary: 'Vue 状态管理' }]])
      }
    }
    expect(await org.describeSome(10)).toBe(1)
    expect(sent).toBe('类型安全的 Vue 状态管理库')
    expect(sent).not.toMatch(/</)
    const [t] = repo.getTabs(['p'])
    expect(t.enrichedBy).toBe('cloud')
    expect(t.topics).toEqual(['前端开发'])
    expect(repo.ai.aiData('p')).toMatchObject({ fetchStatus: 'ok', content: '类型安全的 Vue 状态管理库' })
    expect(repo.ai.vecOf('p')).toBeInstanceOf(Float32Array)
    expect(repo.search('状态管理库').map((x) => x.id)).toContain('p') // FTS covers page content
  })
  it('cloud failure falls back to local and reports the error', async () => {
    repo.insertTabs([{ id: 'q', url: 'https://q.example/', title: 'Q page', sessionId: null, collectionId: null }])
    cfg.aiCloudOrganize = true
    const errs: string[] = []
    org.hooks = {
      enrichBatch: async () => {
        throw new Error('云端 AI：网络不通或超时')
      },
      onError: (m) => errs.push(m)
    }
    expect(await org.describeSome(10)).toBe(1)
    expect(repo.getTabs(['q'])[0].enrichedBy).toBe('local')
    expect(errs[0]).toContain('网络')
  })
})

describe('cloud AI client (mocked)', () => {
  const mkUsage = (): UsageStore & { n: number } => {
    const u = { day: 'd', tokens: 0, requests: 0, cacheHits: 0 }
    return {
      n: 0,
      get: () => u,
      add(t, hit) {
        if (hit) u.cacheHits++
        else {
          u.tokens += t
          u.requests++
        }
      }
    }
  }
  const mkCache = () => {
    const m = new Map<string, unknown>()
    return { cacheGet: <T>(k: string) => (m.get(k) as T) ?? null, cacheSet: (k: string, v: unknown) => void m.set(k, v) }
  }
  const json = (content: unknown, status = 200) =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { total_tokens: 50 } }),
      { status }
    )
  const client = (fetchImpl: typeof fetch, cap = 0, usage = mkUsage(), cache = mkCache()) =>
    new CloudAI(() => ({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'deepseek-chat', embedModel: 'emb', dailyTokenCap: cap }), {
      usage,
      cache,
      fetchImpl,
      sleep: async () => {}
    })

  it('retries 429/5xx with backoff then succeeds; validates JSON with zod; caches by content hash', async () => {
    let n = 0
    const f = (async () => (++n < 3 ? new Response('busy', { status: n === 1 ? 429 : 503 }) : json({ terms: ['书签', 'bookmark'] }))) as typeof fetch
    const c = client(f)
    expect(await c.rewrite('书签工具')).toEqual(['书签', 'bookmark'])
    expect(n).toBe(3)
    expect(await c.rewrite('书签工具')).toEqual(['书签', 'bookmark'])
    expect(n).toBe(3) // cache hit
  })
  it('asks again once when the model returns invalid JSON, then fails with a schema error', async () => {
    let n = 0
    const ok = client((async () => (++n === 1 ? json('not json') : json({ terms: ['a'] }))) as typeof fetch)
    expect(await ok.rewrite('x')).toEqual(['a'])
    const bad = client((async () => json({ wrong: 1 })) as typeof fetch)
    await expect(bad.rewrite('y')).rejects.toMatchObject({ kind: 'schema' })
  })
  it('does not retry auth errors; enforces the daily token cap', async () => {
    let n = 0
    const c = client((async () => (n++, new Response('no', { status: 401 }))) as typeof fetch)
    const e = await c.rewrite('z').catch((x: CloudError) => x)
    expect(e).toBeInstanceOf(CloudError)
    expect((e as CloudError).kind).toBe('auth')
    expect((e as CloudError).userMessage).toContain('API Key')
    expect(n).toBe(1)
    const capped = client((async () => json({ terms: [] })) as typeof fetch, 10)
    await expect(capped.rewrite('a long query that exceeds the tiny cap')).rejects.toMatchObject({ kind: 'cap' })
  })
  it('batches enrichment (8 per request) and normalizes embeddings', async () => {
    let calls = 0
    const f = (async (url: string, init: RequestInit) => {
      calls++
      if (String(url).endsWith('/embeddings')) {
        const input = JSON.parse(String(init.body)).input as string[]
        return new Response(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: [3, 4, 0, 0, 0, 0, 0, 0] })) }))
      }
      const items = JSON.parse(JSON.parse(String(init.body)).messages[1].content).items as { i: number }[]
      return json({ items: items.map((x) => ({ i: x.i, summary: 's', keywords: ['k'] })) })
    }) as typeof fetch
    const c = client(f)
    const r = await c.enrichBatch(Array.from({ length: 10 }, (_, i) => ({ i, title: `t${i}`, url: `https://a/${i}`, snippet: 'text' })))
    expect(r).toHaveLength(10)
    expect(calls).toBe(2)
    const [v] = await c.embed(['hello'])
    expect(v[0]).toBeCloseTo(0.6)
    expect(v[1]).toBeCloseTo(0.8)
  })
  it('connection test reports ok / readable error; token estimate is sane', async () => {
    expect(await client((async () => json({ ok: true })) as typeof fetch).test()).toMatchObject({ ok: true, model: 'deepseek-chat' })
    const t = await client((async () => new Response('x', { status: 401 })) as typeof fetch).test()
    expect(t.ok).toBe(false)
    expect(t.error).toContain('API Key')
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdabcd')).toBe(2)
  })
})

describe('weekly digest', () => {
  it('summarizes the week compactly and lists stale items', () => {
    const now = new Date('2026-10-20T10:00:00Z')
    const day = (n: number) => new Date(now.getTime() - n * 86400000).toISOString()
    const d = weeklyDigest({
      now,
      readLaterId: 'rl',
      organizedThisWeek: 3,
      duplicates: 2,
      tabs: [
        {
          id: '1',
          title: 'a',
          domain: 'github.com',
          createdAt: day(1),
          lastActiveAt: null,
          collectionId: null,
          topics: ['前端开发'],
          keywords: ['React'],
          linkStatus: 'ok'
        },
        {
          id: '2',
          title: 'b',
          domain: 'github.com',
          createdAt: day(2),
          lastActiveAt: null,
          collectionId: null,
          topics: ['前端开发'],
          keywords: ['Vue'],
          linkStatus: 'ok'
        },
        { id: '3', title: 'c', domain: 'x.com', createdAt: day(10), lastActiveAt: null, collectionId: null, keywords: [], linkStatus: 'ok' },
        { id: '4', title: 'd', domain: 'y.com', createdAt: day(40), lastActiveAt: null, collectionId: null, keywords: [], linkStatus: 'broken' },
        { id: '5', title: 'e', domain: 'z.com', createdAt: day(20), lastActiveAt: day(20), collectionId: 'rl', keywords: [], linkStatus: 'ok' }
      ]
    })
    expect(d).toMatchObject({ added: 2, addedPrev: 1, organized: 3 })
    expect(d.topTopics[0]).toEqual({ name: '前端开发', count: 2 })
    expect(d.topSites[0]).toMatchObject({ name: 'GitHub', count: 2 })
    expect(d.stale.map((s) => s.kind)).toEqual(['readLater', 'unsorted', 'dead', 'dup'])
  })
})

describe('bilingual query expansion', () => {
  it('maps 书签 → bookmark so Chinese queries find English pages', async () => {
    const { parseNlQuery } = await import('../shared/ai/nlquery')
    const q = parseNlQuery('书签管理工具')
    expect(q.expansions).toContain('bookmark')
    expect(q.terms).not.toContain('bookmark')
  })
})
