import { createHash } from 'node:crypto'
import { z, type ZodTypeAny } from 'zod'

export interface CloudCfg {
  apiKey: string
  baseUrl: string
  model: string
  embedModel?: string
  /** 0 = unlimited */
  dailyTokenCap: number
}

export type CloudErrorKind = 'auth' | 'rate' | 'server' | 'network' | 'schema' | 'cap' | 'config'
export class CloudError extends Error {
  constructor(
    public kind: CloudErrorKind,
    message: string
  ) {
    super(message)
  }
  get userMessage(): string {
    const m: Record<CloudErrorKind, string> = {
      auth: 'API Key 无效或无权限（401/403），请在设置里检查',
      rate: '请求过于频繁（429），已自动重试仍失败，稍后再试',
      server: '云端服务暂时不可用（5xx）',
      network: '网络不通或超时',
      schema: '模型返回格式不符合要求',
      cap: '已达到今日云端 AI 用量上限（设置里可调整）',
      config: '云端 AI 未配置'
    }
    return `云端 AI：${m[this.kind]}`
  }
}

export interface UsageStore {
  get(): { day: string; tokens: number; requests: number; cacheHits: number }
  add(tokens: number, cacheHit?: boolean): void
}
export interface KvCache {
  cacheGet<T>(key: string): T | null
  cacheSet(key: string, v: unknown): void
}

/** Rough token estimate: CJK ≈ 1 token/char, latin ≈ 1 token/4 chars. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/** USD per 1M tokens (input, output) for common presets; rough, for the settings estimate only. */
const PRICES: [RegExp, number, number][] = [
  [/deepseek/i, 0.28, 0.42],
  [/qwen-turbo|qwen-flash/i, 0.05, 0.2],
  [/qwen-plus/i, 0.11, 0.28],
  [/qwen/i, 0.4, 1.2],
  [/moonshot|kimi/i, 0.6, 2.5],
  [/gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini/i, 0.15, 0.6],
  [/gpt-4o|gpt-4\.1|gpt-5/i, 2.5, 10],
  [/embedding/i, 0.02, 0],
  [/jev/i, 0.042, 0]
]

/** TypeSafe (System One / Jev): structured decisions via POST /v1/systemone, not chat. */
export const isTypeSafe = (baseUrl: string) => /(^|\/\/|\.)typesafe\.ai(\/|$)/i.test(baseUrl)

export const systemOneSchema = z.object({
  model: z.string(),
  answers: z.record(
    z.object({
      type: z.string(),
      noul: z.number().optional(),
      choice: z.string().optional(),
      confidence: z.number().nullable().optional(),
      score: z.number().optional()
    })
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional()
})
export type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export const PAGE_KINDS: Record<string, string> = {
  官网: 'The home page / landing page of a product, company or organisation',
  博客文章: 'A blog post, article, announcement or news story',
  文档: 'Technical documentation, API reference or a help center page',
  开源仓库: 'A source code repository (GitHub, Gitee…)',
  视频: 'A video page',
  社区讨论: 'A forum thread, Q&A or community discussion',
  商品页: 'A product / shopping page with a price',
  价格页: 'A pricing / plans page',
  工具应用: 'A web app or online tool the user works in',
  登录页: 'A login / sign-up page',
  网页: 'Anything else'
}
export function estimateCostUsd(model: string, tokens: number): number | null {
  const p = PRICES.find(([re]) => re.test(model))
  return p ? Math.round(((tokens * (p[1] * 0.7 + p[2] * 0.3)) / 1e6) * 10000) / 10000 : null
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const enrichSchema = z.object({
  items: z
    .array(
      z.object({
        i: z.number().int(),
        description: z.string().max(400).optional(),
        keywords: z.array(z.string().max(40)).max(12).optional(),
        topics: z.array(z.string().max(30)).max(6).optional(),
        summary: z.string().max(300).optional(),
        points: z.array(z.string().max(120)).max(6).optional(),
        lang: z.string().max(8).optional()
      })
    )
    .max(50)
})
export const classifySchema = z.object({
  items: z.array(z.object({ i: z.number().int(), folder: z.string().min(1).max(80), confidence: z.coerce.number().min(0).max(1).catch(0.5) })).max(100)
})
export const rewriteSchema = z.object({ terms: z.array(z.string().min(1).max(30)).max(12) })
export const answerSchema = z.object({ answer: z.string().max(2000), cites: z.array(z.number().int()).max(20).default([]) })

export interface CloudDeps {
  usage: UsageStore
  cache: KvCache
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  retries?: number
}

/** OpenAI-compatible client: retries with backoff, zod-validated JSON, content-hash cache, daily token cap. */
export class CloudAI {
  constructor(
    private cfg: () => CloudCfg | null,
    private deps: CloudDeps
  ) {}

  get ready(): boolean {
    return !!this.cfg()
  }

  /** TypeSafe Jev answers typed questions; it cannot write text, embed, rewrite queries or chat. */
  get typesafe(): boolean {
    const c = this.cfg()
    return !!c && isTypeSafe(c.baseUrl)
  }

  get modelName(): string {
    return this.cfg()?.model ?? ''
  }

  /** POST /v1/systemone with typed questions. Cached by content hash; counts input+output tokens. */
  async systemOne(state: unknown, questions: Record<string, SystemOneQuestion>, cacheKey?: string): Promise<z.infer<typeof systemOneSchema>> {
    const c = this.conf()
    const body = { model: c.model || 'jev-latest', state, questions }
    const key =
      'ts1:' +
      createHash('sha256')
        .update(cacheKey ?? JSON.stringify(body))
        .digest('hex')
        .slice(0, 32)
    const hit = this.deps.cache.cacheGet<z.infer<typeof systemOneSchema>>(key)
    if (hit && systemOneSchema.safeParse(hit).success) {
      this.deps.usage.add(0, true)
      return hit
    }
    const est = estimateTokens(JSON.stringify(body)) + 20 * Object.keys(questions).length
    this.checkCap(est)
    const j = await this.post('/systemone', body, 30000)
    const r = systemOneSchema.safeParse(j)
    if (!r.success) throw new CloudError('schema', 'bad systemone response')
    this.deps.usage.add((r.data.usage?.input_tokens ?? est) + (r.data.usage?.output_tokens ?? 0))
    this.deps.cache.cacheSet(key, r.data)
    return r.data
  }

  /**
   * TypeSafe enrichment for one page: page type, topic, which candidate sentences are key points, which concepts apply.
   * The caller turns these decisions into Chinese text (Jev returns probabilities, not prose).
   */
  async typesafeEnrich(
    item: { title: string; url: string; snippet: string; sentences: string[]; concepts: string[] },
    topics: string[]
  ): Promise<{ kind: string; topic: string | null; topicConf: number; sentenceScores: number[]; concepts: string[]; model: string }> {
    const q: Record<string, SystemOneQuestion> = {
      kind: { type: 'choice', instructions: 'What kind of web page is this?', criteria: PAGE_KINDS }
    }
    const tp = [...new Set(topics)].slice(0, 60)
    if (tp.length >= 2)
      q.topic = { type: 'choice', instructions: 'Which bookmark category fits this page best?', criteria: Object.fromEntries(tp.map((t) => [t, ''])) }
    item.sentences.slice(0, 8).forEach((s, i) => {
      q[`s${i}`] = {
        type: 'noul',
        instructions: `Does this sentence state one of the main points of the page (not boilerplate or a call to action)? Sentence: "${s.slice(0, 240)}"`
      }
    })
    item.concepts.slice(0, 6).forEach((c, i) => {
      q[`c${i}`] = { type: 'noul', instructions: `Is the page substantially about: ${c}?` }
    })
    const r = await this.systemOne({ title: item.title, url: item.url, content: item.snippet.slice(0, 1500) }, q)
    const a = r.answers
    return {
      kind: a.kind?.choice ?? '网页',
      topic: a.topic?.choice ?? null,
      topicConf: a.topic?.confidence ?? 0,
      sentenceScores: item.sentences.slice(0, 8).map((_, i) => a[`s${i}`]?.noul ?? 0),
      concepts: item.concepts.slice(0, 6).filter((_, i) => (a[`c${i}`]?.noul ?? 0) >= 0.5),
      model: r.model
    }
  }

  private conf(): CloudCfg {
    const c = this.cfg()
    if (!c) throw new CloudError('config', 'cloud AI not configured')
    return c
  }

  private checkCap(est: number): void {
    const c = this.conf()
    if (c.dailyTokenCap > 0 && this.deps.usage.get().tokens + est > c.dailyTokenCap) throw new CloudError('cap', 'daily token cap reached')
  }

  private async post(path: string, body: unknown, timeoutMs = 30000, method: 'POST' | 'GET' = 'POST'): Promise<unknown> {
    const c = this.conf()
    const f = this.deps.fetchImpl ?? fetch
    const sleep = this.deps.sleep ?? sleepMs
    const tries = this.deps.retries ?? 3
    let last: CloudError = new CloudError('network', 'no attempt')
    for (let n = 0; n < tries; n++) {
      try {
        const res = await f(`${c.baseUrl.replace(/\/$/, '')}${path}`, {
          method,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
          body: method === 'GET' ? undefined : JSON.stringify(body)
        })
        if (res.ok) return await res.json()
        if (res.status === 401 || res.status === 403) throw new CloudError('auth', `HTTP ${res.status}`)
        if (res.status === 400 || res.status === 404 || res.status === 422)
          throw new CloudError('config', `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`)
        last = new CloudError(res.status === 429 ? 'rate' : 'server', `HTTP ${res.status}`)
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20000) : 800 * 2 ** n + Math.random() * 300)
      } catch (e) {
        if (e instanceof CloudError && (e.kind === 'auth' || e.kind === 'config')) throw e
        last = e instanceof CloudError ? e : new CloudError('network', e instanceof Error ? e.message : String(e))
        if (n < tries - 1) await sleep(800 * 2 ** n + Math.random() * 300)
      }
    }
    throw last
  }

  /** Chat completion that must return JSON matching `schema` (one corrective retry on schema failure). Cached by prompt hash. */
  async chatJSON<S extends ZodTypeAny>(
    schema: S,
    system: string,
    user: string,
    o: { temperature?: number; cacheKey?: string; maxTokens?: number } = {}
  ): Promise<z.output<S>> {
    type T = z.output<S>
    const c = this.conf()
    const key =
      'chat:' +
      createHash('sha256')
        .update(`${c.model}\n${system}\n${o.cacheKey ?? user}`)
        .digest('hex')
        .slice(0, 32)
    const hit = this.deps.cache.cacheGet<T>(key)
    if (hit) {
      const ok = schema.safeParse(hit)
      if (ok.success) {
        this.deps.usage.add(0, true)
        return ok.data
      }
    }
    const est = estimateTokens(system + user) + (o.maxTokens ?? 600)
    this.checkCap(est)
    let messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
    for (let attempt = 0; attempt < 2; attempt++) {
      const j = (await this.post('/chat/completions', {
        model: c.model,
        temperature: o.temperature ?? 0.2,
        max_tokens: o.maxTokens ?? 1200,
        response_format: { type: 'json_object' },
        messages
      })) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } }
      const content = j.choices?.[0]?.message?.content ?? ''
      this.deps.usage.add(j.usage?.total_tokens ?? estimateTokens(system + user + content))
      const m = /\{[\s\S]*\}/.exec(content)
      let parsed: unknown = null
      try {
        parsed = m ? JSON.parse(m[0]) : null
      } catch {
        parsed = null
      }
      const r = schema.safeParse(parsed)
      if (r.success) {
        this.deps.cache.cacheSet(key, r.data)
        return r.data
      }
      messages = [...messages, { role: 'assistant', content }, { role: 'user', content: '格式不对。只返回符合要求的 JSON 对象，不要其他文字。' }]
    }
    throw new CloudError('schema', 'invalid JSON from model')
  }

  /** Batched enrichment from extracted page text (never raw HTML). */
  async enrichBatch(items: { i: number; title: string; url: string; snippet: string }[]): Promise<z.infer<typeof enrichSchema>['items']> {
    const out: z.infer<typeof enrichSchema>['items'] = []
    for (let k = 0; k < items.length; k += 8) {
      const batch = items.slice(k, k + 8).map((x) => ({ ...x, snippet: x.snippet.slice(0, 900) }))
      const r = await this.chatJSON(
        enrichSchema,
        '你是书签元信息助手，为语义搜索、自动分类和阅读回顾生成元数据。对每一项返回：summary（1-2 句中文总结，不超过80字，说清「这是什么网站/页面、讲了什么」，不要照抄原文描述，英文网页也用中文写）、points（3-5 条中文要点，每条不超过30字）、description（不超过60字中文描述）、keywords（3-8个关键词，含中英文同义词）、topics（1-3个中文主题，如 前端开发/AI 工具/电商运营/投资理财）、lang（网页原文语言 zh/en/ja…）。只返回 JSON：{"items":[{"i":0,"summary":"","points":[],"description":"","keywords":[],"topics":[],"lang":"zh"}]}',
        JSON.stringify({ items: batch }),
        { cacheKey: batch.map((b) => createHash('sha1').update(`${b.title}\n${b.url}\n${b.snippet}`).digest('hex')).join(','), maxTokens: 450 * batch.length }
      )
      out.push(...r.items)
    }
    return out
  }

  async classifyBatch(batch: { i: number; title: string; url: string; hint?: string }[], folders: string[]): Promise<z.infer<typeof classifySchema>['items']> {
    if (this.typesafe) {
      const choices = [...new Set(folders)].filter(Boolean).slice(0, 254)
      if (choices.length < 2) return []
      const out: z.infer<typeof classifySchema>['items'] = []
      for (const b of batch) {
        const r = await this.systemOne(
          { title: b.title, url: b.url, hint: b.hint ?? '' },
          {
            folder: {
              type: 'choice',
              instructions: 'Which existing bookmark folder should this page go into?',
              criteria: Object.fromEntries(choices.map((f) => [f, '']))
            }
          }
        )
        const a = r.answers.folder
        if (a?.choice) out.push({ i: b.i, folder: a.choice, confidence: a.confidence ?? 0.5 })
      }
      return out
    }
    const r = await this.chatJSON(
      classifySchema,
      '你是书签分类助手。把每个网页归入一个收藏夹路径（用 / 分隔，最多两级，中文，名称简短有意义，如「AI 工具」「电商运营」）。优先使用已有收藏夹；确实不合适时可以提出新的。只返回 JSON：{"items":[{"i":0,"folder":"开发/文档","confidence":0.0-1.0}]}',
      JSON.stringify({ folders: folders.slice(0, 300), items: batch }),
      { temperature: 0, maxTokens: 60 * batch.length + 100 }
    )
    return r.items
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const c = this.conf()
    if (!c.embedModel) throw new CloudError('config', 'no embedding model')
    const out: Float32Array[] = []
    for (let k = 0; k < texts.length; k += 16) {
      const part = texts.slice(k, k + 16).map((t) => t.slice(0, 1500))
      const est = part.reduce((n, t) => n + estimateTokens(t), 0)
      this.checkCap(est)
      const j = (await this.post('/embeddings', { model: c.embedModel, input: part }, 20000)) as {
        data?: { embedding?: number[]; index?: number }[]
        usage?: { total_tokens?: number }
      }
      const rows = z.array(z.object({ embedding: z.array(z.number()).min(8), index: z.number().int().optional() })).safeParse(j.data)
      if (!rows.success || rows.data.length !== part.length) throw new CloudError('schema', 'bad embeddings response')
      this.deps.usage.add(j.usage?.total_tokens ?? est)
      for (const r of [...rows.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
        const v = Float32Array.from(r.embedding)
        let n = 0
        for (const x of v) n += x * x
        n = Math.sqrt(n) || 1
        out.push(v.map((x) => x / n))
      }
    }
    return out
  }

  async rewrite(q: string): Promise<string[]> {
    if (this.typesafe) return []
    const r = await this.chatJSON(
      rewriteSchema,
      '把用户对自己书签库的自然语言搜索改写成 3-8 个检索关键词（中英文同义词、产品名，去掉时间/浏览器等条件词）。只返回 JSON：{"terms":["..."]}',
      q,
      { temperature: 0, maxTokens: 120 }
    )
    return r.terms
  }

  async answer(q: string, items: { id: string; title: string; url: string; text: string }[]): Promise<{ answer: string; cites: number[] }> {
    if (this.typesafe) throw new CloudError('config', 'TypeSafe Jev cannot write answers')
    return this.chatJSON(
      answerSchema,
      '你是用户的个人书签库助手。只根据给出的条目回答问题，用中文，简洁（不超过150字）。引用条目时写 [n]（n 为条目序号）。没有相关条目就直说。只返回 JSON：{"answer":"...","cites":[1,2]}',
      JSON.stringify({ question: q, items: items.map((x, n) => ({ n: n + 1, title: x.title, url: x.url, info: x.text })) }),
      { temperature: 0.2, maxTokens: 500 }
    )
  }

  /** Connection test: tiny JSON round trip (+ embeddings when configured). */
  async test(): Promise<{ ok: boolean; ms: number; model: string; embed: boolean | null; error?: string }> {
    const t0 = Date.now()
    const c = this.cfg()
    if (!c) return { ok: false, ms: 0, model: '', embed: null, error: new CloudError('config', '').userMessage }
    try {
      if (isTypeSafe(c.baseUrl)) {
        const r = await this.systemOne(`ping ${Date.now()}`, { ok: { type: 'noul', instructions: 'Is this text a ping?' } })
        return { ok: true, ms: Date.now() - t0, model: r.model, embed: null }
      }
      await this.chatJSON(z.object({ ok: z.boolean() }), '只返回 JSON：{"ok":true}', `ping ${Date.now()}`, { maxTokens: 20, temperature: 0 })
      let embed: boolean | null = null
      if (c.embedModel)
        embed = await this.embed(['TabNest']).then(
          () => true,
          () => false
        )
      return { ok: true, ms: Date.now() - t0, model: c.model, embed }
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, model: c.model, embed: null, error: e instanceof CloudError ? e.userMessage : String(e) }
    }
  }
}
