import fixture from './fixtures/classify-fixture.json'
import { classify as classifyLegacy } from './legacy135/autoorg/engine'
import { classify, type Exemplar } from '../shared/autoorg/engine'
import { enrichLocal } from '../shared/ai/enrich-local'
import { centroid, embedLocal } from '../shared/ai/vector'
import { extractDomain } from '../shared/url'
import { siteOf } from '../shared/cluster'
import type { PageFacts } from '../shared/ai/extract'

export interface EvalRow {
  url: string
  title: string
  label: string
  before: string | null
  after: string | null
  afterKnn: string | null
  conf: number
}

const page = (title: string, desc: string): PageFacts => ({
  title,
  description: desc,
  ogTitle: '',
  ogDescription: '',
  siteName: '',
  metaKeywords: [],
  headings: [],
  paragraphs: [],
  lang: ''
})

/** Before = 1.3.5 engine (title+url). After = content-aware enrichment + hybrid classifier; afterKnn adds leave-one-out kNN. */
export function evaluate(): { rows: EvalRow[]; before: number; after: number; afterKnn: number; calib: { bin: string; n: number; acc: number }[] } {
  const items = (fixture as [string, string, string, string][]).map(([url, title, desc, label]) => {
    const domain = extractDomain(url)
    const e = enrichLocal(title, url, domain, page(title, desc))
    const vec = embedLocal({ title, keywords: e.keywords, topics: e.topics, text: e.content, site: siteOf(domain) })
    return { url, title, label, domain, e, vec }
  })
  const rows: EvalRow[] = items.map((it, i) => {
    const b = classifyLegacy({ url: it.url, domain: it.domain, title: it.title })
    const t = { url: it.url, domain: it.domain, title: it.title, description: it.e.description, keywords: it.e.keywords, topics: it.e.topics }
    const a = classify(t)
    // leave-one-out folder centroids (what organize() uses in the app)
    const by = new Map<string, Float32Array[]>()
    items.forEach((o, j) => j !== i && by.set(o.label, [...(by.get(o.label) ?? []), o.vec]))
    const ex: Exemplar[] = [...by].map(([label, vs]) => ({ folderId: 'f:' + label, path: label, vec: centroid(vs)!, size: vs.length }))
    const k = classify(t, [], { vec: it.vec, exemplars: ex })
    return {
      url: it.url,
      title: it.title,
      label: it.label,
      before: b?.folderPath ?? null,
      after: a?.folderPath ?? null,
      afterKnn: k ? (k.folderPath ?? k.folderId?.slice(2) ?? null) : null,
      conf: a?.confidence ?? 0
    }
  })
  const acc = (f: (r: EvalRow) => string | null) => rows.filter((r) => f(r) === r.label).length / rows.length
  const bins = [0, 0.5, 0.75, 0.9, 1.01]
  const calib = bins.slice(0, -1).map((lo, i) => {
    const inBin = rows.filter((r) => r.after && r.conf >= lo && r.conf < bins[i + 1])
    return { bin: `${lo}-${Math.min(1, bins[i + 1])}`, n: inBin.length, acc: inBin.length ? inBin.filter((r) => r.after === r.label).length / inBin.length : 0 }
  })
  return { rows, before: acc((r) => r.before), after: acc((r) => r.after), afterKnn: acc((r) => r.afterKnn), calib }
}

if (process.argv[1]?.endsWith('classifier-eval.ts')) {
  const r = evaluate()
  for (const x of r.rows) if (x.after !== x.label) console.log('MISS', x.label, '<-', x.after, x.conf, x.title.slice(0, 50))
  console.log(`n=${r.rows.length} before=${(r.before * 100).toFixed(1)}% after=${(r.after * 100).toFixed(1)}% after+kNN=${(r.afterKnn * 100).toFixed(1)}%`)
  console.log(r.calib)
}
