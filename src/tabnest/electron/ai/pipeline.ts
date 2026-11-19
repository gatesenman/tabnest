import { createHash } from 'node:crypto'
import { enrichLocal, type LocalEnrichment } from '../../shared/ai/enrich-local'
import { embedLocal } from '../../shared/ai/vector'
import { siteOf } from '../../shared/cluster'
import type { PageFacts } from '../../shared/ai/extract'
import { fetchPage, HostLimiter, type FetchOpts } from './fetchpage'

export interface EnrichJob {
  id: string
  title: string
  url: string
  domain: string
}
export interface EnrichOut {
  id: string
  e: LocalEnrichment
  /** plain number[] so it survives structured clone between processes */
  vec: number[]
  fetchStatus: string
  contentHash: string
  /** extracted page facts (null when not fetched) — lets cloud adapters re-rank the same candidate sentences */
  page: PageFacts | null
  /** HTTP status seen while fetching (null when not fetched / network error) */
  httpCode: number | null
}

const limiter = new HostLimiter(3, 2000)

/** Fetch (optional) → extract → local enrichment → local vector, for a batch. Runs inside the AI utility process. */
export async function runEnrichJobs(jobs: EnrichJob[], o: { fetch: boolean } & FetchOpts): Promise<EnrichOut[]> {
  return Promise.all(
    jobs.map(async (j) => {
      const r = o.fetch
        ? await limiter.run(j.url, () => fetchPage(j.url, o))
        : ({ ok: false, status: 'offline' } as { ok: false; status: string; code?: number })
      const e = enrichLocal(j.title, j.url, j.domain, r.ok ? r.page : null)
      const vec = embedLocal({ title: j.title, keywords: e.keywords, topics: e.topics, text: e.content, site: siteOf(j.domain) })
      const contentHash = createHash('sha1').update(`${j.title}\n${j.url}\n${e.content}`).digest('hex').slice(0, 20)
      return {
        id: j.id,
        e,
        vec: Array.from(vec),
        fetchStatus: r.ok ? 'ok' : r.status,
        contentHash,
        page: r.ok ? r.page : null,
        httpCode: r.ok ? r.status : (r.code ?? null)
      }
    })
  )
}
