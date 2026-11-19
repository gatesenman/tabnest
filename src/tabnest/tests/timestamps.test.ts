import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeIso, safeMs } from '../shared/time'
import { Repo } from '../electron/db'
import { CaptureService } from '../electron/capture'

describe('safe timestamps (regression: RangeError Invalid time value in snapshotAll, 1.2.0)', () => {
  it('rejects NaN / Infinity / garbage / epoch-0 / far-future and accepts real times', () => {
    for (const bad of [NaN, Infinity, -1, 0, 1e20, 13_300_000_000_000_000, 'garbage', undefined, null, new Date('x')]) expect(safeIso(bad)).toBeNull()
    expect(safeIso(Date.UTC(2026, 9, 14))).toBe('2026-10-14T00:00:00.000Z')
    expect(safeMs('2026-10-14T00:00:00Z')).toBe(Date.UTC(2026, 9, 14))
  })

  it('snapshotAll never throws on tabs with invalid lastActive and still saves every tab', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabnest-ts-'))
    const repo = new Repo(join(dir, 't.db'))
    try {
      const settings = { get: () => ({ selectedProfiles: [], autoSnapshotMinutes: 0, onboardingDone: true }) }
      const svc = new CaptureService(repo, settings as never, () => {})
      const mk = (url: string, lastActive: number) => ({
        url,
        title: url,
        pinned: false,
        windowIndex: 0,
        browserId: 'edge',
        browserName: 'Edge',
        profileId: 'Default',
        profileName: '默认',
        lastActive
      })
      ;(svc as unknown as { gather: () => unknown }).gather = async () => ({
        tabs: [mk('https://a.com/', NaN), mk('https://b.com/', 1e20), mk('https://c.com/', -5), mk('https://d.com/', Date.now())],
        byBrowser: { Edge: 4 },
        byBrowserId: { edge: 4 },
        source: 'session'
      })
      const r = await svc.snapshotAll('manual')
      expect(r.dayTotal).toBe(4)
      expect(repo.snapshot().tabs.filter((t) => t.lastActiveAt).length).toBe(1)
    } finally {
      repo.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
