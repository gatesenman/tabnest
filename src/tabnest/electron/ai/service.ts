import log from 'electron-log/main'
import type { Repo } from '../db'
import { localDay } from '../db'
import { CloudAI, CloudError, estimateCostUsd, type CloudCfg, type UsageStore } from './cloud'
import type { SmartResult } from './store'
import { weeklyDigest, type WeeklyDigest } from '../../shared/ai/digest'
import { classify, type OrgRule } from '../../shared/autoorg/engine'
import type { Enrichment } from '../../shared/ai-heuristic'
import type { PageFacts } from '../../shared/ai/extract'
import { candidateSentences, summarizeLocal, zhConcepts } from '../../shared/ai/summarize'
import { KEYWORD_HINTS } from '../../shared/autoorg/sites'

export interface CloudEnrichItem {
  id: string
  title: string
  url: string
  domain?: string
  snippet: string
  page?: PageFacts | null
  keywords?: string[]
  topics?: string[]
}
export type CloudEnrichment = Partial<Enrichment> & { points?: string[]; engine?: string }

const TOPIC_LEAVES = [...new Set(KEYWORD_HINTS.map(([, f]) => f.split('/').at(-1)!))]

export interface AiSettings {
  aiCloudOrganize: boolean
  aiBaseUrl: string
  aiModel: string
  aiEmbedModel?: string
  aiDailyTokenCap?: number
}

/** Daily token usage, persisted in settings (resets at local midnight). */
export function usageStore(repo: Repo): UsageStore {
  const read = () => {
    try {
      const u = JSON.parse(repo.getSetting('aiUsage') ?? 'null') as { day: string; tokens: number; requests: number; cacheHits: number } | null
      return u && u.day === localDay() ? u : { day: localDay(), tokens: 0, requests: 0, cacheHits: 0 }
    } catch {
      return { day: localDay(), tokens: 0, requests: 0, cacheHits: 0 }
    }
  }
  return {
    get: read,
    add(tokens, cacheHit) {
      const u = read()
      if (cacheHit) u.cacheHits++
      else {
        u.tokens += tokens
        u.requests++
      }
      repo.setSetting('aiUsage', JSON.stringify(u))
    }
  }
}

export interface AskResult {
  source: 'cloud' | 'local'
  answer: string | null
  cites: { n: number; id: string; title: string }[]
  search: SmartResult
  error?: string
}

/** Cloud AI (only when the user enabled it) + natural-language search, Q&A, digest, explanations. */
export class AiService {
  readonly cloud: CloudAI
  private lastToast = 0

  constructor(
    private repo: Repo,
    private cfg: () => AiSettings,
    private apiKey: () => string | null,
    private toast: (msg: string) => void = () => {}
  ) {
    this.cloud = new CloudAI(() => this.cloudCfg(), { usage: usageStore(repo), cache: repo.ai })
  }

  cloudCfg(): CloudCfg | null {
    const s = this.cfg()
    const key = this.apiKey()
    if (!s.aiCloudOrganize || !key) return null
    return { apiKey: key, baseUrl: s.aiBaseUrl, model: s.aiModel, embedModel: s.aiEmbedModel || undefined, dailyTokenCap: s.aiDailyTokenCap ?? 200000 }
  }

  /** Throttled, user-facing error toast (at most one per 5 minutes). */
  reportError(e: unknown): string {
    const msg = e instanceof CloudError ? e.userMessage : `云端 AI：${e instanceof Error ? e.message : String(e)}`
    log.warn('cloud ai', msg)
    if (Date.now() - this.lastToast > 5 * 60000) {
      this.lastToast = Date.now()
      this.toast(`${msg}（已改用本地引擎）`)
    }
    return msg
  }

  /** Human label for the cloud engine shown in the 「AI 摘要」 card. */
  engineLabel(model?: string): string {
    const s = this.cfg()
    return this.cloud.typesafe ? `TypeSafe ${model || s.aiModel || 'jev-latest'}` : `云端 AI · ${model || s.aiModel}`
  }

  async enrichBatch(items: CloudEnrichItem[]): Promise<Map<string, CloudEnrichment>> {
    const out = new Map<string, CloudEnrichment>()
    try {
      if (this.cloud.typesafe) {
        let k = 0
        const worker = async () => {
          while (k < items.length) {
            const x = items[k++]
            out.set(x.id, await this.typesafeOne(x))
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
        return out
      }
      const r = await this.cloud.enrichBatch(items.map((x, i) => ({ i, title: x.title.slice(0, 200), url: x.url.slice(0, 300), snippet: x.snippet })))
      const engine = this.engineLabel()
      for (const x of r) if (items[x.i]) out.set(items[x.i].id, { ...x, engine })
    } catch (e) {
      throw new Error(this.reportError(e))
    }
    return out
  }

  /** TypeSafe Jev picks page type, topic, key sentences and applicable concepts; Chinese text is composed locally from those decisions. */
  private async typesafeOne(x: CloudEnrichItem): Promise<CloudEnrichment> {
    const { sents } = candidateSentences(x.page)
    const text = [x.title, x.snippet].join(' ')
    const concepts = [...new Set([...zhConcepts(text, 6), ...(x.keywords ?? []).filter((k) => /[\u4e00-\u9fff]/.test(k)).slice(0, 2)])].slice(0, 6)
    const r = await this.cloud.typesafeEnrich(
      { title: x.title.slice(0, 200), url: x.url.slice(0, 300), snippet: x.snippet, sentences: sents.slice(0, 8), concepts },
      [...(x.topics ?? []), ...TOPIC_LEAVES]
    )
    const order = r.sentenceScores
      .map((p, i) => [p, i] as const)
      .filter(([p]) => p >= 0.3)
      .sort((a, b) => b[0] - a[0])
      .map(([, i]) => i)
    const sum = summarizeLocal(
      { title: x.title, url: x.url, domain: x.domain ?? '', page: x.page, keywords: x.keywords, topics: x.topics },
      { order: order.length ? order : undefined, kind: r.kind, concepts: r.concepts.length ? r.concepts : undefined }
    )
    const topics = r.topic && r.topicConf >= 0.4 ? [...new Set([r.topic, ...(x.topics ?? [])])].slice(0, 5) : x.topics
    return { summary: sum.summary, points: sum.points, topics, engine: this.engineLabel(r.model) }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.cloudCfg()?.embedModel) return []
    return this.cloud.embed(texts)
  }

  /** 智能搜索. Local parse + hybrid ranking always; cloud query rewrite / embedding only when enabled (short timeouts). */
  async smartSearch(q: string, limit = 300, useCloud = true): Promise<SmartResult & { rewritten?: string[] }> {
    const local = this.repo.ai.smartSearch(q, { limit })
    const c = useCloud ? this.cloudCfg() : null
    if (!c || !q.trim() || local.items.length >= 20) return local
    try {
      const timeout = <T>(p: Promise<T>, ms: number) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new CloudError('network', 'timeout')), ms))])
      const [rewrite, qEmb] = await Promise.all([
        timeout(this.cloud.rewrite(q), 3500).catch(() => [] as string[]),
        c.embedModel
          ? timeout(this.cloud.embed([q]), 3000).then(
              (v) => v[0] ?? null,
              () => null
            )
          : Promise.resolve(null)
      ])
      if (!rewrite.length && !qEmb) return local
      const r = this.repo.ai.smartSearch(q, { limit, rewrite, qEmb })
      return { ...r, rewritten: rewrite }
    } catch {
      return local
    }
  }

  /** AI 问答 (RAG over top-k results). Offline / failure → the NL search results only. */
  async ask(q: string): Promise<AskResult> {
    const search = await this.smartSearch(q, 50)
    if (!this.cloudCfg() || this.cloud.typesafe) return { source: 'local', answer: null, cites: [], search }
    const ctx = this.repo.ai.ragContext(
      search.items.map((x) => x.id),
      12
    )
    if (!ctx.length) return { source: 'cloud', answer: '你的收藏里没有找到相关内容。', cites: [], search }
    try {
      const r = await this.cloud.answer(q, ctx)
      const cites = [...new Set(r.cites)].filter((n) => n >= 1 && n <= ctx.length).map((n) => ({ n, id: ctx[n - 1].id, title: ctx[n - 1].title }))
      return { source: 'cloud', answer: r.answer, cites, search }
    } catch (e) {
      return { source: 'local', answer: null, cites: [], search, error: this.reportError(e) }
    }
  }

  usage() {
    const u = usageStore(this.repo).get()
    const s = this.cfg()
    return { ...u, cap: s.aiDailyTokenCap ?? 200000, costUsd: estimateCostUsd(s.aiModel, u.tokens), model: s.aiModel }
  }

  digest(): WeeklyDigest {
    const snap = this.repo.snapshot()
    const weekAgo = Date.now() - 7 * 86400000
    const organized = this.repo
      .orgLog(500)
      .filter((e) => !e.undone && Date.parse(e.at) >= weekAgo)
      .reduce((n, e) => n + (e.data.moves?.length ?? 0), 0)
    return weeklyDigest({
      tabs: snap.tabs,
      readLaterId: snap.collections.find((c) => c.builtin && c.name === '稍后阅读')?.id ?? null,
      organizedThisWeek: organized,
      duplicates: this.repo.ai.nearDuplicates().length
    })
  }

  /** Why an item is (or would be) in a folder — for the detail pane. */
  explain(
    id: string,
    rules: OrgRule[]
  ): {
    stored: string | null
    live: { target: string; confidence: number; basis: string[] } | null
    page: ReturnType<Repo['ai']['aiData']>
    cloud: { configured: boolean; label: string | null }
  } {
    const cloud = { configured: !!this.cloudCfg(), label: this.cloudCfg() ? this.engineLabel() : null }
    const [t] = this.repo.getTabs([id])
    if (!t) return { stored: null, live: null, page: null, cloud }
    const c = classify(t, rules, { vec: this.repo.ai.vecOf(id), exemplars: this.repo.ai.exemplars() })
    const name = c?.folderId ? this.repo.collectionRow(c.folderId)?.name : c?.folderPath
    const page = this.repo.ai.aiData(id)
    return {
      stored: t.orgReason ?? null,
      live: c && name ? { target: name, confidence: c.confidence, basis: c.basis ?? [c.reason] } : null,
      page: page ? { ...page, content: page.content.slice(0, 400) } : null,
      cloud
    }
  }
}
