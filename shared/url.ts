const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'spm',
  'ref_src',
  'igshid',
  '_hsenc',
  '_hsmi'
])

export function extractDomain(url: string): string {
  try {
    return new URL(url.trim()).hostname.replace(/^www\./, '') || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function faviconFor(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`
  } catch {
    return ''
  }
}

export function ensureHttp(url: string): string {
  const t = url.trim()
  if (!t) return t
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  if (t.startsWith('//')) return 'https:' + t
  return 'https://' + t
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Canonical form for duplicate detection: lowercase host, no www, no tracking params, no hash, sorted query, no trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim())
    u.hash = ''
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = ''
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()) && !k.toLowerCase().startsWith('utm_'))
      .sort(([a], [b]) => a.localeCompare(b))
    u.search = ''
    for (const [k, v] of params) u.searchParams.append(k, v)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '')
    let s = u.toString()
    if (u.pathname === '/') s = s.replace(/\/(\?|$)/, '$1')
    return s.replace(/^http:\/\//, 'https://')
  } catch {
    return url.trim().toLowerCase()
  }
}

/** Parse pasted text: URL lines | title<TAB>url | title | url | [title](url) | JSON array */
export function parseTabLines(text: string): { title: string; url: string }[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') && !trimmed.startsWith('[](')) {
    try {
      const arr: unknown = JSON.parse(trimmed)
      if (Array.isArray(arr)) {
        const out: { title: string; url: string }[] = []
        for (const item of arr) {
          if (typeof item === 'string') {
            const url = ensureHttp(item)
            if (isHttpUrl(url)) out.push({ title: extractDomain(url), url })
          } else if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>
            const url = ensureHttp(String(o.url ?? o.href ?? ''))
            if (isHttpUrl(url)) out.push({ title: String(o.title ?? o.name ?? extractDomain(url)), url })
          }
        }
        return out
      }
    } catch {
      /* not JSON, treat as lines */
    }
  }
  const results: { title: string; url: string }[] = []
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const md = line.match(/^[-*]?\s*\[([^\]]*)\]\(([^)\s]+)\)/)
    if (md) {
      const url = ensureHttp(md[2])
      if (isHttpUrl(url)) results.push({ title: md[1] || extractDomain(url), url })
      continue
    }
    if (line.includes('\t')) {
      const [a, b] = line.split('\t')
      const url = ensureHttp((b ?? a).trim())
      if (isHttpUrl(url)) results.push({ title: (b ? a.trim() : '') || extractDomain(url), url })
      continue
    }
    const pipe = line.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)$/i)
    if (pipe) {
      results.push({ title: pipe[1].trim(), url: pipe[2] })
      continue
    }
    if (/^https?:\/\//i.test(line) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(line)) {
      const url = ensureHttp(line.split(/\s+/)[0])
      if (isHttpUrl(url)) results.push({ title: extractDomain(url), url })
    }
  }
  return results
}

export function defaultSessionName(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = d.getHours()
  const period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${period}`
}
