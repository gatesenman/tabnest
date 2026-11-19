/** HTML → compact, model-ready page facts (no DOM needed; runs in the AI worker). */
export interface PageFacts {
  title: string
  description: string
  ogTitle: string
  ogDescription: string
  siteName: string
  metaKeywords: string[]
  headings: string[]
  paragraphs: string[]
  lang: string
}

const ENT: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®'
}
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENT[e.toLowerCase()] ?? m
  })
}

const clean = (s: string, max = 300) =>
  decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : ''
}

/** Charset from Content-Type header or the first <meta charset>. */
export function sniffCharset(contentType: string | null, head: string): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]
  const cs = (fromHeader || fromMeta || 'utf-8').toLowerCase()
  return cs === 'gb2312' || cs === 'gbk' ? 'gb18030' : cs
}

export function extractPage(html: string): PageFacts {
  const h = html
    .slice(0, 600_000)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
  const metas = new Map<string, string>()
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') || attr(m[0], 'name') || attr(m[0], 'itemprop')).toLowerCase()
    const content = attr(m[0], 'content')
    if (key && content && !metas.has(key)) metas.set(key, clean(content, 400))
  }
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1] ?? '', 200)
  const body = /<body\b[\s\S]*$/i.exec(h)?.[0] ?? h
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(body)?.[0] ?? body
  const noChrome = main.replace(/<(nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
  const headings: string[] = []
  for (const m of noChrome.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = clean(m[2], 120)
    if (t.length >= 2 && !headings.includes(t)) headings.push(t)
    if (headings.length >= 8) break
  }
  const paragraphs: string[] = []
  for (const m of noChrome.matchAll(/<(p|li|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = clean(m[2], 400)
    const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (cjk >= 15 || t.split(' ').length >= 10) paragraphs.push(t)
    if (paragraphs.length >= 12) break
  }
  return {
    title,
    description: metas.get('description') ?? '',
    ogTitle: metas.get('og:title') ?? metas.get('twitter:title') ?? '',
    ogDescription: metas.get('og:description') ?? metas.get('twitter:description') ?? '',
    siteName: metas.get('og:site_name') ?? metas.get('application-name') ?? '',
    metaKeywords: (metas.get('keywords') ?? '')
      .split(/[,，、;；|]/)
      .map((x) => x.trim())
      .filter((x) => x && x.length <= 30)
      .slice(0, 12),
    headings,
    paragraphs,
    lang: (attr(/<html\b[^>]*>/i.exec(h)?.[0] ?? '', 'lang') || '').toLowerCase().slice(0, 8)
  }
}

/** Plain text snippet sent to cloud AI / stored for search (never raw HTML). */
export function pageSnippet(p: PageFacts, max = 1200): string {
  const parts = [
    p.ogTitle && p.ogTitle !== p.title ? p.ogTitle : '',
    p.description || p.ogDescription,
    p.metaKeywords.length ? `关键词：${p.metaKeywords.join('、')}` : '',
    p.headings.slice(0, 6).join(' / '),
    ...p.paragraphs
  ].filter(Boolean)
  return parts.join('\n').slice(0, max)
}
