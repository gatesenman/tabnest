import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearLockedCache, copyLocked, filterNoise, pickChromiumSession, RETRY_DELAYS, type CopyIO, type SessionFile } from '../electron/browsers/read'
import { runCloseFlow, strategyFor, type FlowBrowser } from '../electron/closeflow'

const ebusy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
const fixture = readFileSync('tests/fixtures/chromium-1248.Session')
const emptySnss = Buffer.concat([Buffer.from('SNSS'), Buffer.from([3, 0, 0, 0])])

function io(over: Partial<CopyIO>): CopyIO & { sleeps: number[]; written: Buffer[] } {
  const sleeps: number[] = []
  const written: Buffer[] = []
  return {
    exists: () => true,
    readFile: () => Buffer.from('ok'),
    writeFile: (_p, b) => void written.push(b),
    readChunked: () => Buffer.from('chunk'),
    shellCopy: null,
    sleep: (ms) => void sleeps.push(ms),
    ...over,
    sleeps,
    written
  }
}

describe('copyLocked', () => {
  it('primary path: readFileSync + writeFileSync (works while Chrome holds a shared lock)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn-lock-'))
    const src = join(dir, 'Session_1')
    writeFileSync(src, fixture)
    const out = copyLocked(src, 'snss')!
    expect(readFileSync(out).equals(fixture)).toBe(true)
  })

  it('falls back to chunked fd reads with 50/150/400 ms backoff', () => {
    let n = 0
    const m = io({
      readFile: () => {
        throw ebusy()
      },
      readChunked: () => {
        if (++n < 3) throw ebusy()
        return Buffer.from('third time')
      }
    })
    expect(copyLocked('C:/x/Session_1', 's', m)).not.toBeNull()
    expect(m.sleeps).toEqual(RETRY_DELAYS)
    expect(m.written[0].toString()).toBe('third time')
  })

  it('tries the PowerShell share-all copy last and never throws (exclusive lock → null)', () => {
    let shell = 0
    const m = io({
      readFile: () => {
        throw ebusy()
      },
      readChunked: () => {
        throw ebusy()
      },
      shellCopy: () => (shell++, false)
    })
    expect(copyLocked('C:/x/Session_1', 's', m)).toBeNull()
    expect(shell).toBe(1)
    expect(copyLocked('missing', 's', io({ exists: () => false }))).toBeNull()
  })
  it('perf: an unchanged locked file is skipped instantly on the next read (no retries / shell copy)', () => {
    clearLockedCache()
    let shell = 0
    const busy = io({
      readFile: () => {
        throw ebusy()
      },
      readChunked: () => {
        throw ebusy()
      },
      shellCopy: () => (shell++, false),
      sig: () => '1:100'
    })
    expect(copyLocked('/x/Session_9', 'snss', busy)).toBeNull()
    expect(busy.sleeps).toHaveLength(RETRY_DELAYS.length)
    expect(copyLocked('/x/Session_9', 'snss', busy)).toBeNull()
    expect(busy.sleeps).toHaveLength(RETRY_DELAYS.length)
    expect(shell).toBe(1)
    // file changed → tried again
    busy.sig = () => '2:120'
    expect(copyLocked('/x/Session_9', 'snss', busy)).toBeNull()
    expect(shell).toBe(2)
    clearLockedCache()
  })
})

describe('pickChromiumSession', () => {
  const f = (path: string, kind: SessionFile['kind'], mtime: number): SessionFile => ({ path, kind, mtime })

  it('reads the newest Session_* when it is not locked (fresh)', () => {
    const r = pickChromiumSession([f('Session_3', 'session', 300), f('Session_2', 'session', 200)], () => fixture)
    expect(r).toMatchObject({ locked: false, stale: false, sourceFile: 'Session_3', sourceMtime: 300 })
    expect(r.windows.flatMap((w) => w.tabs).length).toBeGreaterThan(5)
  })

  it('newest Session_* exclusively locked → falls back to older unlocked file, flags stale + mtime', () => {
    const files = [f('Session_3', 'session', 300), f('Tabs_3', 'tabs', 299), f('Session_2', 'session', 200)]
    const r = pickChromiumSession(files, (x) => (x.path === 'Session_3' || x.path === 'Tabs_3' ? null : fixture))
    expect(r).toMatchObject({ locked: true, stale: true, sourceFile: 'Session_2', sourceMtime: 200 })
    expect(r.windows.length).toBeGreaterThan(0)
  })

  it('prefers whichever of Session_* / Tabs_* yields more live tabs', () => {
    const files = [f('Session_3', 'session', 300), f('Tabs_3', 'tabs', 300)]
    const r = pickChromiumSession(files, (x) => (x.kind === 'tabs' ? fixture : emptySnss))
    expect(r.sourceFile).toBe('Tabs_3')
    expect(r.stale).toBe(false)
  })

  it('everything locked → empty, locked, not crashing', () => {
    const r = pickChromiumSession([f('Session_3', 'session', 300)], () => null)
    expect(r).toMatchObject({ windows: [], locked: true, sourceFile: null })
  })
})

describe('filterNoise', () => {
  it('drops internal pages when real ones exist, keeps non-blank internals if that is all', () => {
    expect(filterNoise([{ url: 'edge://newtab/' }, { url: 'https://a.com' }]).map((t) => t.url)).toEqual(['https://a.com'])
    expect(filterNoise([{ url: 'about:blank' }, { url: 'chrome://settings' }, { url: 'vivaldi://newtab' }]).map((t) => t.url)).toEqual(['chrome://settings'])
  })
})

describe('runCloseFlow ordering', () => {
  const chrome: FlowBrowser = { id: 'chrome', name: 'Chrome', running: true, locked: false, profileKeys: ['chrome::Default'] }
  const edge: FlowBrowser = { id: 'edge', name: 'Edge', running: true, locked: true, profileKeys: ['edge::Default'] }

  it('strategy: close-then-read (locked & running) > snapshot-then-close', () => {
    expect(strategyFor(chrome)).toBe('snapshot-then-close')
    expect(strategyFor(edge)).toBe('close-then-read')
  })

  it('snapshots readable browsers before closing; closes locked ones BEFORE reading them', async () => {
    const events: string[] = []
    const r = await runCloseFlow([edge, chrome], {
      log: (e) => events.push(e),
      snapshot: (_k, ids) => Object.fromEntries(ids.map((id) => [id, id === 'edge' ? 12 : 5])),
      close: async (ids) => ids.map((id) => ({ id, process: id, closed: true, forced: false }))
    })
    expect(events).toEqual(['snapshot:chrome', 'close:chrome', 'close:edge', 'snapshot:edge'])
    expect(r.captured).toEqual({ chrome: 5, edge: 12 })
    expect(r.unread).toEqual([])
  })

  it('never closes a readable browser whose snapshot came back empty', async () => {
    const closed: string[] = []
    const r = await runCloseFlow([chrome], {
      snapshot: () => ({}),
      close: async (ids) => (closed.push(...ids), [])
    })
    expect(closed).toEqual([])
    expect(r.skipped[0].id).toBe('chrome')
  })

  it('locked browser that still cannot be read after closing → reported as unread (restore via browser)', async () => {
    const r = await runCloseFlow([edge], {
      snapshot: () => ({}),
      close: async (ids) => ids.map((id) => ({ id, process: id, closed: true, forced: false }))
    })
    expect(r.unread).toEqual([{ id: 'edge', name: 'Edge' }])
  })

  it('locked browser that refuses to close → skipped, never read', async () => {
    let snaps = 0
    const r = await runCloseFlow([edge], {
      snapshot: () => (snaps++, {}),
      close: async (ids) => ids.map((id) => ({ id, process: id, closed: false, forced: true }))
    })
    expect(snaps).toBe(0)
    expect(r.skipped[0].id).toBe('edge')
  })
})
