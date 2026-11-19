import { describe, expect, it } from 'vitest'
import { checkLink, runPool, type FetchLike } from '../electron/linkcheck'

const res = (status: number, location?: string) => ({ status, headers: { get: (n: string) => (n === 'location' ? (location ?? null) : null) }, body: null })

describe('checkLink', () => {
  it('classifies ok / redirect / broken and retries HEAD-rejecting servers with GET', async () => {
    const calls: string[] = []
    const f: FetchLike = async (url, init) => {
      calls.push(init.method)
      if (url.endsWith('/ok')) return res(200)
      if (url.endsWith('/moved')) return res(301, 'https://new')
      if (url.endsWith('/nohead')) return init.method === 'HEAD' ? res(405) : res(200)
      return res(404)
    }
    expect((await checkLink('https://x/ok', 1000, undefined, f)).status).toBe('ok')
    expect(await checkLink('https://x/moved', 1000, undefined, f)).toMatchObject({ status: 'redirect', statusCode: 301, note: '→ https://new' })
    expect(await checkLink('https://x/gone', 1000, undefined, f)).toMatchObject({ status: 'broken', statusCode: 404 })
    calls.length = 0
    expect((await checkLink('https://x/nohead', 1000, undefined, f)).status).toBe('ok')
    expect(calls).toEqual(['HEAD', 'GET'])
  })

  it('reports timeouts and network errors', async () => {
    const hang: FetchLike = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('This operation was aborted'))))
    expect((await checkLink('https://x', 50, undefined, hang)).status).toBe('timeout')
    const fail: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND x')
    }
    expect(await checkLink('https://x', 50, undefined, fail)).toMatchObject({ status: 'broken' })
  })
})

describe('runPool', () => {
  it('respects the concurrency limit and stops on cancel', async () => {
    let active = 0
    let peak = 0
    const done: number[] = []
    const ctrl = new AbortController()
    await runPool([...Array(20).keys()], 5, ctrl.signal, async (i) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      done.push(i)
      if (i === 9) ctrl.abort()
    })
    expect(peak).toBe(5)
    expect(done.length).toBeLessThan(20)
  })
})
