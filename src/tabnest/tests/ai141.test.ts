import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '../electron/db'
import { AutoOrganizer, type OrgSettings } from '../electron/autoorg'
import { extractPage } from '../shared/ai/extract'
import { enrichLocal } from '../shared/ai/enrich-local'
import { candidateSentences, pageKind, siteDisplayName, smartTruncate, summarizeLocal, textRank } from '../shared/ai/summarize'
import { CloudAI, isTypeSafe, type UsageStore } from '../electron/ai/cloud'
import { AiService } from '../electron/ai/service'

const TYPESAFE_HTML = `<html lang="en"><head><title>Introducing System One Models &amp; Jev - TypeSafe AI Blog</title>
<meta name="description" content="TypeSafe AI is an AI lab building machine-native intelligence infrastructure for automation, designed to make decisions within software. Try our first System One Model, Jev, in early access.">
</head><body><nav>Home Blog</nav><article><h1>Introducing System One Models &amp; Jev</h1>
<p>Models have been superhuman at chat for years, so where is all the automation in our software today?</p>
<p>We built a new stack entirely focused on automation, where models return typed decisions instead of prose.</p>
<p>Our first public model is Jev, available today in early access for developers building software.</p>
<p>Sign up for the newsletter to get the latest updates from our team every single month.</p></article></body></html>`

const ZH_HTML = `<html lang="zh-CN"><head><title>Pinia 入门：Vue 的状态管理库 - 少数派</title><meta property="og:site_name" content="少数派 - 高品质数字消费指南">
<meta name="description" content="Pinia 是 Vue 官方推荐的状态管理库。"></head><body><article>
<p>Pinia 是 Vue 官方推荐的状态管理库，它取代了 Vuex，API 更简单，并且完整支持 TypeScript 类型推断。</p>
<p>本文从安装开始，介绍如何定义 store、在组件中读取状态，以及如何用插件持久化数据到本地存储。</p>
<p>最后对比 Pinia 与 Vuex 的差异，帮助你判断老项目是否值得迁移，以及迁移时需要注意的问题。</p></article></body></html>`

describe('smart truncation', () => {
  it('never cuts mid-word and marks the cut', () => {
    const s = 'TypeSafe AI is an AI lab building machine-native intelligence infrastructure for automation'
    const t = smartTruncate(s, 60)
    expect(t.endsWith('…')).toBe(true)
    expect(s.startsWith(t.slice(0, -1).trim())).toBe(true)
    expect(s[t.length - 1]).toMatch(/[\s]/) // the char after the kept part is a space → whole words only
    expect(smartTruncate('短句。', 10)).toBe('短句。')
    expect(smartTruncate('第一句话说完了。第二句话还很长很长很长很长很长很长', 16)).toBe('第一句话说完了。')
  })
})

describe('local summarizer (TextRank + Chinese framing)', () => {
  it('English page: Chinese framing, differs from the meta description, 3–5 key points', () => {
    const page = extractPage(TYPESAFE_HTML)
    const url = 'https://typesafe.ai/blog/introducing-system-one-models-and-jev'
    const e = enrichLocal('Introducing System One Models & Jev - TypeSafe AI Blog', url, 'typesafe.ai', page)
    expect(e.summary).toMatch(/^TypeSafe 博客文章：/)
    expect(e.summary).toMatch(/[\u4e00-\u9fff]/)
    expect(e.summary).toContain('AI 实验室')
    expect(e.summary).not.toBe(e.description)
    expect(e.summary).not.toContain(e.description.slice(0, 40))
    expect(e.points.length).toBeGreaterThanOrEqual(3)
    expect(e.points.length).toBeLessThanOrEqual(5)
    expect(e.summarySrc).toBe('page')
  })
  it('Chinese page: summary is a ranked body sentence with site + kind, not the description', () => {
    const page = extractPage(ZH_HTML)
    const s = summarizeLocal({ title: 'Pinia 入门：Vue 的状态管理库 - 少数派', url: 'https://sspai.com/post/1', domain: 'sspai.com', page })
    expect(s.summary).toMatch(/^少数派 博客文章：/)
    expect(s.summary).not.toBe('Pinia 是 Vue 官方推荐的状态管理库。')
    expect(s.points.length).toBeGreaterThanOrEqual(3)
    expect(s.source).toBe('page')
  })
  it('title-only: framed by page kind, labelled as title source', () => {
    const s = summarizeLocal({ title: 'facebook/react', url: 'https://github.com/facebook/react', domain: 'github.com', page: null })
    expect(s.summary).toMatch(/GitHub 开源仓库/)
    expect(s.source).toBe('title')
  })
  it('helpers: page kind, brand casing, TextRank prefers central sentences', () => {
    expect(pageKind('https://typesafe.ai/', 'typesafe.ai')).toBe('官网')
    expect(pageKind('https://docs.python.org/3/library/', 'docs.python.org')).toBe('文档')
    expect(siteDisplayName('', 'Introducing Jev - TypeSafe AI Blog', 'typesafe.ai')).toBe('TypeSafe')
    expect(siteDisplayName('少数派 - 高品质数字消费指南', '', 'sspai.com')).toBe('少数派')
    const order = textRank(['React 组件 状态 渲染', 'React 组件 和 状态 管理', '今天天气不错 出去走走', 'React 状态 渲染 优化'])
    expect(order[order.length - 1]).toBe(2)
    expect(candidateSentences(extractPage(TYPESAFE_HTML)).sents.length).toBeGreaterThanOrEqual(4)
  })
})

const mkUsage = (): UsageStore => {
  const u = { day: 'd', tokens: 0, requests: 0, cacheHits: 0 }
  return { get: () => u, add: (t, hit) => (hit ? u.cacheHits++ : ((u.tokens += t), u.requests++)) as unknown as void }
}
const mkCache = () => {
  const m = new Map<string, unknown>()
  return { cacheGet: <T>(k: string) => (m.get(k) as T) ?? null, cacheSet: (k: string, v: unknown) => void m.set(k, v) }
}
/** Fake TypeSafe /v1/systemone: answers every question; marks s1/s2 + first concept as true. */
const fakeTypeSafe = (calls: { url: string; body: { questions: Record<string, { type: string; criteria?: unknown }> } }[]) =>
  (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const answers: Record<string, unknown> = {}
    for (const [k, q] of Object.entries(body.questions as Record<string, { type: string; criteria?: Record<string, string> }>)) {
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria ?? {})
        const pick = k === 'kind' ? '博客文章' : (keys.find((x) => /AI/.test(x)) ?? keys[0])
        answers[k] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: {} }
      } else answers[k] = { type: 'noul', noul: k === 's1' || k === 's2' || k === 'c0' ? 0.9 : 0.1 }
    }
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 20 } }), { status: 200 })
  }) as unknown as typeof fetch

describe('TypeSafe (System One / Jev) adapter', () => {
  it('detects the provider and calls POST /v1/systemone with typed questions', async () => {
    expect(isTypeSafe('https://api.typesafe.ai/v1')).toBe(true)
    expect(isTypeSafe('https://api.deepseek.com/v1')).toBe(false)
    const calls: Parameters<Parameters<typeof fakeTypeSafe>[0]['push']>[0][] = []
    const c = new CloudAI(() => ({ apiKey: 'k', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', dailyTokenCap: 0 }), {
      usage: mkUsage(),
      cache: mkCache(),
      fetchImpl: fakeTypeSafe(calls),
      sleep: async () => {}
    })
    const t = await c.test()
    expect(t).toMatchObject({ ok: true, model: 'jev-1.13.0' })
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(await c.rewrite('x')).toEqual([])
    await expect(c.answer('q', [])).rejects.toThrow()
    const cls = await c.classifyBatch([{ i: 0, title: 'Claude', url: 'https://claude.ai' }], ['AI 工具', '购物'])
    expect(cls[0]).toMatchObject({ folder: 'AI 工具' })
  })
  it('service composes a Chinese summary + points from Jev decisions, labelled TypeSafe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabnest-ts-'))
    const repo = new Repo(join(dir, 't.db'))
    try {
      const calls: never[] = []
      const svc = new AiService(
        repo,
        () => ({ aiCloudOrganize: true, aiBaseUrl: 'https://api.typesafe.ai/v1', aiModel: 'jev-latest', aiDailyTokenCap: 200000 }),
        () => 'k'
      )
      ;(svc.cloud as unknown as { deps: { fetchImpl: typeof fetch; sleep: () => Promise<void> } }).deps.fetchImpl = fakeTypeSafe(calls as never)
      const page = extractPage(TYPESAFE_HTML)
      const url = 'https://typesafe.ai/blog/introducing-system-one-models-and-jev'
      const loc = enrichLocal('Introducing System One Models & Jev - TypeSafe AI Blog', url, 'typesafe.ai', page)
      const m = await svc.enrichBatch([
        {
          id: 'a',
          title: 'Introducing System One Models & Jev - TypeSafe AI Blog',
          url,
          domain: 'typesafe.ai',
          snippet: loc.content,
          page,
          keywords: loc.keywords,
          topics: loc.topics
        }
      ])
      const r = m.get('a')!
      expect(r.engine).toBe('TypeSafe jev-1.13.0')
      expect(r.summary).toMatch(/^TypeSafe 博客文章：/)
      expect(r.points!.length).toBeGreaterThanOrEqual(2)
      expect(r.points![0]).toMatch(/^Try our first System One Model/) // only Jev's picks (s1, s2), in page order
      expect(r.points!.join(' ')).not.toMatch(/AI lab building/)
    } finally {
      repo.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('describeSome stores the structured summary and reuses the fetch HTTP status as link check', () => {
  let dir: string
  let repo: Repo
  let cfg: OrgSettings
  let org: AutoOrganizer
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabnest-ai141-'))
    repo = new Repo(join(dir, 't.db'))
    cfg = {
      autoOrganize: true,
      autoOrganizeThreshold: 0.75,
      groupThreshold: 8,
      aiCloudOrganize: false,
      aiBaseUrl: 'https://x/v1',
      aiModel: 'm',
      aiFetchPages: true
    }
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
  it('local engine: points + 本地摘要 label + page source; link status ok (200), 404 → broken', async () => {
    repo.insertTabs([
      {
        id: 'ts',
        url: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev',
        title: 'Introducing System One Models & Jev - TypeSafe AI Blog',
        sessionId: null,
        collectionId: null
      },
      { id: 'gone', url: 'https://gone.example/x', title: 'Gone', sessionId: null, collectionId: null }
    ])
    org.hooks = {
      pipeline: async (jobs) => {
        const { runEnrichJobs } = await import('../electron/ai/pipeline')
        return runEnrichJobs(jobs, {
          fetch: true,
          fetchImpl: (async (u: string) =>
            String(u).includes('gone')
              ? new Response('nope', { status: 404 })
              : new Response(TYPESAFE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
        })
      }
    }
    expect(await org.describeSome(10)).toBe(2)
    const [t] = repo.getTabs(['ts'])
    expect(t.summary).toMatch(/^TypeSafe 博客文章：/)
    expect(t.summary).not.toBe(t.description)
    expect(t.linkStatus).toBe('ok')
    const d = repo.ai.aiData('ts')!
    expect(d.engine).toBe('本地摘要')
    expect(d.summarySrc).toBe('page')
    expect(d.points.length).toBeGreaterThanOrEqual(3)
    expect(repo.getTabs(['gone'])[0].linkStatus).toBe('broken')
    expect(repo.ai.aiData('gone')!.summarySrc).toBe('title')
    expect(org.lastDescribe).toMatchObject({ engines: ['本地摘要'], page: 1, title: 1 })
  })
  it('ENRICH_VERSION 3 re-queues 1.4.0 summaries (summary == truncated description)', async () => {
    repo.insertTabs([{ id: 'old', url: 'https://a.example/', title: 'A', sessionId: null, collectionId: null }])
    repo.setEnrichment('old', { description: 'Long English description here', keywords: [], topics: [], summary: 'A：Long English descr', lang: 'en' }, 'local')
    ;(repo as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db.prepare('UPDATE tabs SET enrich_v = 2').run()
    expect(repo.needEnrichment(10).map((x) => x.id)).toContain('old')
  })
})
