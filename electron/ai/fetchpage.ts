import { extractPage, sniffCharset, type PageFacts } from '../../shared/ai/extract'

export interface FetchOpts {
  timeoutMs?: number
  maxBytes?: number
  fetchImpl?: typeof fetch
}

export type FetchResult = { ok: true; page: PageFacts; status: number } | { ok: false; status: string; code?: number }

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$|.*\.lan$)/i
/** Pages that need login or are app shells: fetching them yields nothing useful (and may hit rate limits). */
const SKIP =
  /^(mail\.|outlook\.|accounts\.|login\.|passport\.|pan\.baidu|drive\.google|docs\.google|.*\.feishu\.cn|.*\.larksuite|web\.whatsapp|chrome\.google\.com\/webstore)/i

export function canFetch(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (PRIVATE.test(u.hostname) || SKIP.test(u.hostname)) return false
    if (/\.(pdf|zip|exe|dmg|msi|rar|7z|mp4|mp3|png|jpe?g|gif|webp|iso|apk)$/i.test(u.pathname)) return false
    return true
  } catch {
    return false
  }
}

/** GET a page with timeout + byte cap; decodes the declared charset (GBK sites included). Never throws. */
export async function fetchPage(url: string, o: FetchOpts = {}): Promise<FetchResult> {
  if (!canFetch(url)) return { ok: false, status: 'skipped' }
  const max = o.maxBytes ?? 512 * 1024
  const f = o.fetchImpl ?? fetch
  try {
    const res = await f(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 TabNest/1.4',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })
    if (!res.ok) return { ok: false, status: `http ${res.status}`, code: res.status }
    const ct = res.headers.get('content-type')
    if (ct && !/html|xml/i.test(ct)) return { ok: false, status: 'not-html' }
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = res.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || !value) break
        chunks.push(value)
        size += value.byteLength
        if (size >= max) {
          await reader.cancel().catch(() => undefined)
          break
        }
      }
    }
    const buf = new Uint8Array(size)
    let off = 0
    for (const c of chunks) {
      buf.set(c.subarray(0, Math.min(c.byteLength, size - off)), off)
      off += c.byteLength
    }
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096))
    let text: string
    try {
      text = new TextDecoder(sniffCharset(ct, head)).decode(buf)
    } catch {
      text = new TextDecoder('utf-8').decode(buf)
    }
    return { ok: true, page: extractPage(text), status: res.status }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message) : String(e)
    return { ok: false, status: msg.slice(0, 60) }
  }
}

/** Polite scheduler: global concurrency + minimum gap per host. */
export class HostLimiter {
  private last = new Map<string, number>()
  private active = 0
  private queue: (() => void)[] = []
  constructor(
    private concurrency = 3,
    private perHostGapMs = 2000
  ) {}
  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r))
    this.active++
    try {
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        /* ignore */
      }
      const wait = (this.last.get(host) ?? 0) + this.perHostGapMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.last.set(host, Date.now())
      if (this.last.size > 2000) this.last.clear()
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}
