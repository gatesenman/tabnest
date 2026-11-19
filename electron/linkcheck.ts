import type { LinkStatus } from '../shared/types'

export interface CheckResult {
  status: Exclude<LinkStatus, 'checking' | 'unknown'>
  statusCode: number | null
  note: string | null
  checkedAt: string
}

export type FetchLike = (
  url: string,
  init: { method: string; redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }
) => Promise<{ status: number; headers: { get(n: string): string | null }; body?: { cancel?: () => unknown } | null }>

const UA = 'Mozilla/5.0 (TabNest LinkChecker/1.0)'

function classify(code: number, location: string | null): Omit<CheckResult, 'checkedAt'> {
  if (code >= 200 && code < 300) return { status: 'ok', statusCode: code, note: null }
  if (code >= 300 && code < 400) return { status: 'redirect', statusCode: code, note: location ? `→ ${location}` : '重定向' }
  return { status: 'broken', statusCode: code, note: `HTTP ${code}` }
}

/** HEAD first, GET fallback for servers that reject HEAD. Cancel via outer signal. */
export async function checkLink(
  url: string,
  timeoutMs: number,
  outer?: AbortSignal,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<CheckResult> {
  const checkedAt = new Date().toISOString()
  const attempt = async (method: string) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => ctrl.abort(new Error('cancelled'))
    outer?.addEventListener('abort', onAbort)
    try {
      const res = await fetchImpl(url, { method, redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: '*/*' } })
      void res.body?.cancel?.()
      return res
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }
  try {
    let res = await attempt('HEAD')
    if ([400, 403, 405, 501].includes(res.status)) res = await attempt('GET')
    return { ...classify(res.status, res.headers.get('location')), checkedAt }
  } catch (e) {
    if (outer?.aborted) throw e
    const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)
    if (/timeout|abort/i.test(msg)) return { status: 'timeout', statusCode: null, note: '超时', checkedAt }
    return { status: 'broken', statusCode: null, note: msg.slice(0, 120), checkedAt }
  }
}

/** Run checks with a concurrency limit; resolves when all done or cancelled. */
export async function runPool<T>(items: T[], concurrency: number, signal: AbortSignal, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!signal.aborted && i < items.length) {
      const item = items[i++]
      try {
        await worker(item)
      } catch {
        if (signal.aborted) return
      }
    }
  })
  await Promise.all(lanes)
}
