import { detectLang, heuristicEnrich, type Enrichment } from '../ai-heuristic'
import { KEYWORD_HINTS } from '../autoorg/sites'
import { extractKeywords, isStopword } from './segment'
import { pageSnippet, type PageFacts } from './extract'
import { smartTruncate, summarizeLocal } from './summarize'

export interface LocalEnrichment extends Enrichment {
  /** plain-text snippet extracted from the page (empty when not fetched) */
  content: string
  /** 3–5 key points (extractive) */
  points: string[]
  summarySrc: 'page' | 'title'
}

/**
 * Content-aware local enrichment: page facts (title/meta/og/headings/paragraphs) when available,
 * otherwise title + URL. Produces bilingual keywords, topic labels (taxonomy-aligned) and a summary.
 */
export function enrichLocal(title: string, url: string, domain: string, page?: PageFacts | null): LocalEnrichment {
  const base = heuristicEnrich(title, url, domain)
  let path = ''
  try {
    path = decodeURIComponent(new URL(url).pathname).replace(/[/_\-.]+/g, ' ')
  } catch {
    /* ignore */
  }
  const fields = [
    { text: title, weight: 3 },
    { text: page?.ogTitle ?? '', weight: 2 },
    { text: page?.description || page?.ogDescription || '', weight: 2 },
    { text: (page?.metaKeywords ?? []).join(' '), weight: 2.2 },
    { text: (page?.headings ?? []).join(' '), weight: 1.4 },
    { text: (page?.paragraphs ?? []).join(' '), weight: 0.6 },
    { text: path, weight: 0.8 }
  ]
  const kw = extractKeywords(fields, 10)
  const hintKw = base.keywords.filter((k) => /[\u4e00-\u9fff]/.test(k) || /^[A-Z]/.test(k)).slice(0, 3)
  const keywords = [...new Set([...hintKw, ...kw])].filter((k) => !isStopword(k) && k.length <= 24).slice(0, 10)
  const text = [title, page?.description, page?.ogDescription, ...(page?.headings ?? []), keywords.join(' '), path].join(' ')
  const topics = [...new Set([...KEYWORD_HINTS.filter(([re]) => re.test(text)).map(([, f]) => f.split('/').at(-1)!), ...base.topics])].slice(0, 5)
  const desc = (page?.description || page?.ogDescription || '').trim()
  const description = desc ? smartTruncate(desc, 200) : base.description
  const s = summarizeLocal({ title, url, domain, page, keywords, topics })
  const lang = page?.lang?.split('-')[0] || '' || detectLang(`${title} ${desc}`) || base.lang
  return { description, keywords, topics, summary: s.summary, points: s.points, summarySrc: s.source, lang, content: page ? pageSnippet(page) : '' }
}
