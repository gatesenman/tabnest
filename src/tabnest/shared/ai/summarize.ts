/**
 * Local (offline) summarizer: TextRank over page sentences + a Chinese framing sentence built from
 * site type / name / concepts. Never truncates mid-word and never returns the raw meta description verbatim.
 */
import { siteOf } from '../cluster'
import { friendlySite } from './naming'
import { isStopword, segment } from './segment'
import type { PageFacts } from './extract'

export interface LocalSummary {
  summary: string
  points: string[]
  /** where the summary came from: page body/meta, or only title + url */
  source: 'page' | 'title'
}

const CJK = /[\u4e00-\u9fff]/

/** Cut at a sentence / clause / word boundary at or before max chars; append … when cut. */
export function smartTruncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if ([...t].length <= max) return t
  const chars = [...t].slice(0, max)
  const head = chars.join('')
  const strong = Math.max(...['。', '！', '？', '. ', '! ', '? ', '；', '; '].map((p) => head.lastIndexOf(p)))
  if (strong >= max * 0.4) return head.slice(0, strong + 1).trim()
  const weak = Math.max(...['，', '、', ', ', '：', ': ', ' — ', ' - '].map((p) => head.lastIndexOf(p)))
  if (weak >= max * 0.5) return head.slice(0, weak).trim() + '…'
  if (!CJK.test(head.slice(-6))) {
    const sp = head.lastIndexOf(' ')
    if (sp > max * 0.4) return head.slice(0, sp).replace(/[\s,.;:—–-]+$/, '') + '…'
  }
  return head.replace(/[\s,.;:，。、—–-]+$/, '') + '…'
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .split(/(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter((s) => (CJK.test(s) ? [...s].length >= 8 : s.split(' ').length >= 5) && [...s].length <= 400)
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** TextRank (PageRank over sentence-overlap graph). Returns indices ranked best first. */
export function textRank(sentences: string[], bias: number[] = []): number[] {
  const toks = sentences.map((s) => new Set(segment(s).filter((w) => !isStopword(w) && w.length > 1)))
  const n = sentences.length
  const W = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      let c = 0
      for (const w of toks[i]) if (toks[j].has(w)) c++
      const d = Math.log(toks[i].size + 1) + Math.log(toks[j].size + 1)
      W[i][j] = W[j][i] = c && d ? c / d : 0
    }
  const out = W.map((r) => r.reduce((a, b) => a + b, 0))
  let s = new Array<number>(n).fill(1)
  for (let it = 0; it < 30; it++) {
    s = s.map((_, i) => {
      let acc = 0
      for (let j = 0; j < n; j++) if (W[j][i] && out[j]) acc += (W[j][i] / out[j]) * s[j]
      return 0.15 + 0.85 * acc + (bias[i] ?? 0)
    })
  }
  return s
    .map((v, i) => [v, i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map((x) => x[1])
}

/** Small EN→ZH concept glossary so English pages get a Chinese gist offline. Longest match first. */
const GLOSS: [RegExp, string][] = [
  [/\bai (lab|research lab|company)\b/i, 'AI 实验室'],
  [/\bmachine[- ]native\b/i, '机器原生'],
  [/\b(ai )?agents?\b|\bagentic\b/i, '智能体'],
  [/\bllms?\b|\blarge language models?\b|\bfoundation models?\b/i, '大模型'],
  [/\bmodels?\b/i, '模型'],
  [/\binfrastructure\b/i, '基础设施'],
  [/\bautomation\b|\bautomate[sd]?\b/i, '自动化'],
  [/\bsandbox(es)?\b/i, '沙箱'],
  [/\bbrowser\b/i, '浏览器'],
  [/\bopen[- ]source\b/i, '开源'],
  [/\bframework\b/i, '框架'],
  [/\blibrary\b|\bsdk\b/i, '开发库'],
  [/\bapi\b/i, 'API'],
  [/\bplatform\b/i, '平台'],
  [/\bdatabase\b|\bsql\b/i, '数据库'],
  [/\bsecurity\b|\bzero trust\b/i, '安全'],
  [/\bpricing\b|\bplans?\b/i, '价格方案'],
  [/\bstartups?\b/i, '初创公司'],
  [/\btutorial\b|\bguide\b|\bhow to\b/i, '教程'],
  [/\bdocs\b|\bdocumentation\b|\breference\b/i, '文档'],
  [/\bdesign\b/i, '设计'],
  [/\bbookmarks?\b/i, '书签'],
  [/\bsearch\b/i, '搜索'],
  [/\bvideo\b/i, '视频'],
  [/\bdeploy(ment)?\b|\bhosting\b/i, '部署托管'],
  [/\bcloud\b/i, '云服务'],
  [/\bcod(e|ing)\b|\bdevelopers?\b|\bprogramming\b/i, '编程开发'],
  [/\bdecisions?\b/i, '决策'],
  [/\bsoftware\b/i, '软件'],
  [/\bdata\b|\banalytics\b/i, '数据分析'],
  [/\bmarketing\b|\bleads?\b|\bsales\b/i, '营销获客'],
  [/\bpayments?\b|\bbilling\b/i, '支付'],
  [/\bimage(s)?\b|\bphotos?\b/i, '图像'],
  [/\bvoice\b|\bspeech\b|\baudio\b/i, '语音'],
  [/\btranslat/i, '翻译'],
  [/\bnews\b/i, '新闻'],
  [/\bresearch\b|\bpapers?\b/i, '研究']
]
export function zhConcepts(text: string, max = 4): string[] {
  const out: string[] = []
  for (const [re, zh] of GLOSS) if (re.test(text) && !out.includes(zh)) out.push(zh)
  // 模型 is implied by 大模型
  return out.filter((x) => !(x === '模型' && out.includes('大模型'))).slice(0, max)
}

/** What kind of page is it (Chinese label). */
export function pageKind(url: string, domain: string): string {
  let path = '/'
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {
    /* ignore */
  }
  const d = domain.toLowerCase()
  if (/(^|\.)github\.com$|gitee\.com$/.test(d) && path.split('/').filter(Boolean).length >= 2) return '开源仓库'
  if (/bilibili\.com|youtube\.com|youku|v\.qq\.com|douyin/.test(d) || /\/video\//.test(path)) return '视频'
  if (/zhihu\.com\/question|stackoverflow|segmentfault|v2ex|linux\.do/.test(d + path)) return '社区讨论'
  if (/^docs?\.|developer\.|\/docs?\/|\/reference\/|\/api\//.test(d + '/' + path)) return '文档'
  if (/\/(blog|posts?|articles?|news|p|story|stories)\//.test(path)) return '博客文章'
  if (/\/(pricing|plans?)\/?$/.test(path)) return '价格页'
  if (/\/(login|signin|sign-in|register|signup)/.test(path)) return '登录页'
  if (path === '/' || path === '' || /^\/(index\.html?|home|zh|en|zh-cn)?\/?$/.test(path)) return '官网'
  return '网页'
}

/** Human brand name: og:site_name (first segment), else the title's casing of the domain base ("TypeSafe"), else friendlySite. */
export function siteDisplayName(siteName: string, title: string, site: string): string {
  const sn = siteName.split(/\s+[-_|·—–]\s+|[|｜]/)[0].trim()
  if (sn && [...sn].length <= 20) return sn
  const base = site.split('.')[0].replace(/[^a-z0-9]/gi, '')
  if (base.length >= 3) {
    const m = new RegExp(`\\b(${base})\\b`, 'i').exec(title.replace(/[^\p{L}\p{N}\s]/gu, ' '))
    if (m && /[A-Z]/.test(m[1])) return m[1]
  }
  return friendlySite(site)
}

const stripTitle = (title: string, name: string) => {
  const t = title.replace(/\s+/g, ' ').trim()
  const parts = t.split(/\s+[-_|·—–]\s+|\s*[|｜]\s*/)
  const n = norm(name)
  const keep = parts.filter((p) => norm(p) !== n && !(n && norm(p).startsWith(n) && p.length < 30))
  return (keep.length ? keep.join(' · ') : t).trim()
}

/**
 * Build a Chinese-first summary + key points. `page` is null when we only have title + url.
 * keywords/topics come from enrichLocal (used for framing when the page gives little text).
 */
/** Candidate sentences (meta description first, then body paragraphs), max 40, deduplicated. */
export function candidateSentences(p: PageFacts | null | undefined): { sents: string[]; bias: number[] } {
  const desc = (p?.description || p?.ogDescription || '').trim()
  const sents: string[] = []
  const bias: number[] = []
  for (const s of splitSentences(desc)) {
    sents.push(s)
    bias.push(0.2)
  }
  for (const para of p?.paragraphs ?? [])
    for (const s of splitSentences(para)) {
      if (sents.length >= 40) break
      if (sents.some((x) => norm(x) === norm(s))) continue
      sents.push(s)
      bias.push(0)
    }
  if (desc && !sents.length && [...desc].length >= 8) {
    sents.push(desc)
    bias.push(0.2)
  }
  return { sents, bias }
}

/** Overrides supplied by a cloud model that ranks / labels but does not write text (TypeSafe Jev). */
export interface SummaryOverride {
  /** sentence indices (into candidateSentences) best first */
  order?: number[]
  kind?: string
  concepts?: string[]
}

export function summarizeLocal(
  input: { title: string; url: string; domain: string; page?: PageFacts | null; keywords?: string[]; topics?: string[] },
  over: SummaryOverride = {}
): LocalSummary {
  const p = input.page ?? null
  const site = siteOf(input.domain)
  const name = siteDisplayName(p?.siteName ?? '', input.title || p?.title || '', site)
  const kind = over.kind || pageKind(input.url, input.domain)
  const head = smartTruncate(stripTitle(p?.ogTitle || input.title || p?.title || '', name), 48)
  const desc = (p?.description || p?.ogDescription || '').trim()
  const { sents, bias } = candidateSentences(p)
  const ranked = over.order?.length ? over.order.filter((i) => i >= 0 && i < sents.length) : sents.length ? textRank(sents, bias) : []
  const allText = [input.title, desc, ...(p?.headings ?? []), ...sents].join(' ')
  const zh = CJK.test(allText.replace(new RegExp(name, 'g'), '')) && (allText.match(/[\u4e00-\u9fff]/g) ?? []).length > allText.length * 0.15
  const core = [input.title, desc, ...(p?.headings ?? []).slice(0, 3)].join(' ')
  const concepts = over.concepts?.length ? over.concepts.slice(0, 4) : zhConcepts(core, 3).length ? zhConcepts(core, 3) : zhConcepts(allText, 3)
  const topics = (input.topics ?? []).filter((t) => CJK.test(t) && t !== '文章' && t !== '网页').slice(0, 2)
  const framing = `${name} ${kind}`.replace(/^(\S+) (官网|文档)$/, '$1 $2')
  let summary: string
  if (zh && ranked.length) {
    const best = sents[ranked[0]]
    const second = ranked.length > 1 ? sents[ranked[1]] : ''
    let body = smartTruncate(best, 70)
    if ([...body].length < 36 && second) body = smartTruncate(`${body.replace(/[。.]?$/, '。')}${second}`, 90)
    summary = `${framing}：${body.replace(/^[：:，,\s]+/, '')}`
  } else {
    const firstDesc = splitSentences(desc)[0] ?? desc
    const about = head && norm(head) !== norm(name) ? `「${head}」` : firstDesc ? `「${smartTruncate(firstDesc.replace(/[.。]$/, ''), 56)}」` : ''
    const gist = concepts.length ? `内容涉及${concepts.join('、')}` : topics.length ? `属于${topics.join('、')}方向` : ''
    const kws = (input.keywords ?? []).filter((k) => !CJK.test(k) && k.length > 2 && norm(k) !== norm(name)).slice(0, 3)
    const tail = gist || (kws.length ? `关键词 ${kws.join('、')}` : '')
    summary = `${framing}${about ? `：介绍${about}` : ''}${tail ? `${about ? '，' : '：'}${tail}` : ''}。`
  }
  summary = summary.replace(/。。$/, '。')
  // never identical to (or a mere prefix of) the raw description
  if (desc && (norm(summary).includes(norm(desc)) || norm(desc).startsWith(norm(summary.split('：').slice(1).join('：')))) && concepts.length)
    summary = `${framing}：${head ? `「${head}」，` : ''}内容涉及${concepts.join('、')}。`
  const points = ranked
    .slice(0, 5)
    .sort((a, b) => a - b)
    .map((i) => smartTruncate(sents[i], 80))
    .filter((s, i, a) => a.findIndex((x) => norm(x) === norm(s)) === i)
    .slice(0, 5)
  if (points.length < 3)
    for (const h of p?.headings ?? []) {
      if (points.length >= 4) break
      const hh = smartTruncate(h, 60)
      if (!points.some((x) => norm(x).includes(norm(hh))) && norm(hh) !== norm(head)) points.push(hh)
    }
  return { summary: smartTruncate(summary, 140), points, source: p && (desc || sents.length) ? 'page' : 'title' }
}
