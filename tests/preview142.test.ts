import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '../electron/db'
import { PreviewService, urlHash } from '../electron/preview'
import { canPreview, decodePreviewKey, encodePreviewKey, previewSrc } from '../shared/preview'

let dir: string
let repo: Repo
let now: Date
let calls: string[]
let fail: Set<string>
let svc: PreviewService
let enabled = true
let active = false
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabnest-pv-'))
  repo = new Repo(join(dir, 't.db'))
  now = new Date('2026-10-20T08:00:00Z')
  calls = []
  fail = new Set()
  enabled = true
  active = false
  svc = new PreviewService(
    repo.db,
    dir,
    async (u) => {
      calls.push(u)
      if (fail.has(u)) throw new Error('超时')
      return JPG
    },
    { enabled: () => enabled, userActive: () => active, now: () => now, concurrency: 2 }
  )
  repo.insertTabs([
    { id: 'a', url: 'https://a.example/', title: 'A', sessionId: null, collectionId: null },
    { id: 'b', url: 'https://b.example/x', title: 'B', sessionId: null, collectionId: null },
    { id: 'c', url: 'chrome://settings', title: 'C', sessionId: null, collectionId: null },
    { id: 'd', url: 'http://localhost:3000/', title: 'D', sessionId: null, collectionId: null }
  ])
})
afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('preview protocol keys', () => {
  it('round-trips unicode urls through base64url', () => {
    const u = 'https://zh.wikipedia.org/wiki/页签?q=a+b&x=/y'
    expect(decodePreviewKey(encodePreviewKey(u))).toBe(u)
    expect(encodePreviewKey(u)).not.toMatch(/[+/=]/)
    expect(previewSrc(u, 'v1')).toMatch(/^tabnest-preview:\/\/img\/[\w-]+\?v=v1$/)
    expect(canPreview('https://a.example/')).toBe(true)
    expect(canPreview('chrome://settings')).toBe(false)
    expect(canPreview('http://192.168.1.1/')).toBe(false)
  })
})

describe('PreviewService queue + cache', () => {
  it('captures due http(s) urls only, stores files + index, serves paths', async () => {
    expect(svc.due(10).sort()).toEqual(['https://a.example/', 'https://b.example/x'])
    expect(await svc.tick()).toBe(2)
    expect(calls.sort()).toEqual(['https://a.example/', 'https://b.example/x'])
    const p = svc.pathFor('https://a.example/')!
    expect(p.endsWith(`${urlHash('https://a.example/')}.jpg`)).toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(svc.info('https://a.example/')).toMatchObject({ status: 'ok', bytes: JPG.length })
    expect(svc.due(10)).toEqual([])
    expect(svc.stats()).toEqual({ count: 2, bytes: JPG.length * 2, failed: 0 })
  })
  it('backs off failures (1h, 6h…) and refreshes after 30 days', async () => {
    fail.add('https://b.example/x')
    await svc.tick()
    expect(svc.info('https://b.example/x')).toMatchObject({ status: 'failed', error: '超时' })
    now = new Date(now.getTime() + 30 * 60000)
    expect(svc.due(10)).toEqual([]) // still backing off
    now = new Date(now.getTime() + 31 * 60000)
    expect(svc.due(10)).toEqual(['https://b.example/x'])
    await svc.tick()
    now = new Date(now.getTime() + 2 * 3600000)
    expect(svc.due(10)).toEqual([]) // second failure → 6h
    fail.clear()
    now = new Date(now.getTime() + 31 * 86400000)
    expect(svc.due(10).sort()).toEqual(['https://a.example/', 'https://b.example/x']) // a expired, b retry
  })
  it('manual refresh keeps the old thumbnail when a re-capture fails', async () => {
    await svc.refresh('https://a.example/')
    fail.add('https://a.example/')
    const r = await svc.refresh('https://a.example/')
    expect(r.status).toBe('ok')
    expect(svc.pathFor('https://a.example/')).not.toBeNull()
  })
  it('disabled → no work; user active → smaller batches', async () => {
    enabled = false
    expect(await svc.tick()).toBe(0)
    enabled = true
    active = true
    repo.insertTabs(Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, url: `https://x${i}.example/`, title: 'x', sessionId: null, collectionId: null })))
    expect(await svc.tick()).toBe(2)
  })
  it('清空预览缓存 removes files and index; sweep drops orphans', async () => {
    await svc.tick()
    writeFileSync(join(svc.dir, 'orphan.jpg'), JPG)
    svc.sweep()
    expect(readdirSync(svc.dir)).toHaveLength(2)
    expect(svc.clear()).toBe(2)
    expect(readdirSync(svc.dir)).toHaveLength(0)
    expect(svc.stats().count).toBe(0)
    expect(svc.pathFor('https://a.example/')).toBeNull()
  })
})
