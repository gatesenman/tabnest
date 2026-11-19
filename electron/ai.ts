import { heuristicEnrich, heuristicSummary, type Enrichment, type Summary } from '../shared/ai-heuristic'

export interface AiConfig {
  apiKey: string | null
  baseUrl: string
  model: string
}

/** Cloud summary via any OpenAI-compatible endpoint; always falls back to the local heuristic. */
export async function summarize(title: string, url: string, domain: string, cfg: AiConfig): Promise<Summary & { source: 'local' | 'cloud' }> {
  const local = heuristicSummary(title, url, domain)
  if (!cfg.apiKey) return { ...local, source: 'local' }
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: '你是书签助手。根据标题和 URL 生成一句不超过40字的中文描述和3-6个关键词。只返回 JSON：{"description":"...","keywords":["..."]}'
          },
          { role: 'user', content: `标题: ${title}\nURL: ${url}\n域名: ${domain}` }
        ]
      })
    })
    if (!res.ok) return { ...local, source: 'local' }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const m = data.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)
    if (!m) return { ...local, source: 'local' }
    const p = JSON.parse(m[0]) as { description?: unknown; keywords?: unknown }
    return {
      description: typeof p.description === 'string' && p.description ? p.description.slice(0, 200) : local.description,
      keywords: Array.isArray(p.keywords) ? p.keywords.filter((k): k is string => typeof k === 'string').slice(0, 8) : local.keywords,
      source: 'cloud'
    }
  } catch {
    return { ...local, source: 'local' }
  }
}

/** Rich metadata for AI search. Cloud (OpenAI-compatible) when a key is set, else / on any failure the local engine. */
export async function enrich(title: string, url: string, domain: string, cfg: AiConfig): Promise<Enrichment & { source: 'local' | 'cloud' }> {
  const local = heuristicEnrich(title, url, domain)
  if (!cfg.apiKey) return { ...local, source: 'local' }
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              '你是书签元信息助手，为后续语义搜索生成元数据。根据标题和 URL 返回 JSON：{"description":"不超过60字中文描述","keywords":["3-8个关键词，含中英文同义词"],"topics":["1-4个主题分类，如 编程/AI/设计/购物/新闻"],"summary":"一句话摘要，不超过30字","lang":"页面主要语言代码 zh/en/ja…"}。只返回 JSON。'
          },
          { role: 'user', content: `标题: ${title}\nURL: ${url}\n域名: ${domain}` }
        ]
      })
    })
    if (!res.ok) return { ...local, source: 'local' }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const m = data.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)
    if (!m) return { ...local, source: 'local' }
    const p = JSON.parse(m[0]) as Record<string, unknown>
    const strs = (v: unknown, n: number) =>
      Array.isArray(v)
        ? v
            .filter((k): k is string => typeof k === 'string' && !!k)
            .map((k) => k.slice(0, 30))
            .slice(0, n)
        : null
    const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
    return {
      description: str(p.description, 200) ?? local.description,
      keywords: strs(p.keywords, 10) ?? local.keywords,
      topics: strs(p.topics, 5) ?? local.topics,
      summary: str(p.summary, 120) ?? local.summary,
      lang: str(p.lang, 8) ?? local.lang,
      source: 'cloud'
    }
  } catch {
    return { ...local, source: 'local' }
  }
}

export interface SummarizeResult {
  count: number
  missing: number
  source: 'local' | 'cloud'
  reason: string
}

/** Regenerate AI metadata for the given stored tabs (local engine when no cloud key; cloud failures fall back to local). */
export async function summarizeTabs(
  repo: {
    getTabs(ids: string[]): { id: string; title: string; url: string; domain: string }[]
    setEnrichment(id: string, e: Enrichment, by: 'local' | 'cloud'): void
  },
  tabIds: string[],
  cfg: AiConfig,
  run: typeof enrich = enrich
): Promise<SummarizeResult> {
  const tabs = repo.getTabs(tabIds)
  let cloud = 0
  for (const t of tabs) {
    const r = await run(t.title, t.url, t.domain, cfg)
    if (r.source === 'cloud') cloud++
    const { source, ...e } = r
    repo.setEnrichment(t.id, e, source)
  }
  const source = cloud ? 'cloud' : 'local'
  const reason = !cfg.apiKey
    ? '未配置云端 AI，已用本地引擎生成'
    : cloud < tabs.length
      ? `云端 AI 有 ${tabs.length - cloud} 项失败，已用本地引擎补齐`
      : '已用云端 AI 生成'
  return { count: tabs.length, missing: tabIds.length - tabs.length, source, reason }
}
