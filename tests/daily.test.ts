import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayTitle, localDay, mergeSessionsPerDay, Repo } from '../electron/db'
import { diffCaptures } from '../shared/diff'

let dir: string
let repo: Repo
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabnest-daily-'))
  repo = new Repo(join(dir, 't.db'))
})
afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('daily snapshot', () => {
  it('localDay / dayTitle use the machine calendar', () => {
    expect(localDay(new Date(2026, 9, 14, 23, 59))).toBe('2026-10-14')
    expect(dayTitle('2026-10-14')).toMatch(/10月14日/)
  })

  it('merges multiple captures into one day with first/last seen, sources and seen_count', () => {
    const morning = new Date()
    morning.setHours(9, 0, 0, 0)
    const evening = new Date()
    evening.setHours(21, 0, 0, 0)
    const r1 = repo.recordCapture(
      [
        { title: 'GH', url: 'https://github.com/pulls', source: 'chrome::Default' },
        { title: 'A', url: 'https://a.com', source: 'chrome::Default' }
      ],
      morning
    )
    expect(r1.newToday).toBe(2)
    expect(r1.newOverall).toBe(2)
    const r2 = repo.recordCapture(
      [
        { title: 'GitHub Pulls', url: 'http://www.github.com/pulls/?utm_source=x', source: 'edge::Default' },
        { title: 'B', url: 'https://b.com', source: 'firefox::default' }
      ],
      evening
    )
    expect(r2.sessionId).toBe(r1.sessionId)
    expect(r2.newToday).toBe(1) // only b.com is new to today
    expect(r2.newOverall).toBe(1)
    expect(r2.dayTotal).toBe(3)
    const snap = repo.snapshot()
    expect(snap.sessions.filter((s) => s.kind === 'daily')).toHaveLength(1)
    expect(snap.sessions[0].name).toMatch(/月.*日/)
    const gh = snap.tabs.find((t) => t.normUrl.includes('github.com/pulls'))!
    const item = snap.items.find((i) => i.tabId === gh.id)!
    expect(item.title).toBe('GitHub Pulls') // latest title wins
    expect(item.seenCount).toBe(2)
    expect(item.sources.sort()).toEqual(['chrome::Default', 'edge::Default'])
    expect(item.firstSeenAt).toBe(morning.toISOString())
    expect(item.lastSeenAt).toBe(evening.toISOString())
  })

  it('keeps an organized tab linked when it reappears in a later capture', () => {
    const r = repo.recordCapture([{ title: 'A', url: 'https://a.com', source: 'chrome::Default' }])
    const [tab] = repo.snapshot().tabs
    const folder = repo.findCollectionByName('工作')!.id
    repo.moveToCollection([tab.id], folder)
    repo.recordCapture([{ title: 'A again', url: 'https://a.com', source: 'edge::Default' }])
    const again = repo.getTabs([tab.id])[0]
    expect(again.collectionId).toBe(folder)
    expect(again.title).toBe('A again')
    expect(repo.snapshot().items.find((i) => i.tabId === tab.id)!.seenCount).toBe(2)
    expect(r.dayTotal).toBe(1)
  })

  it('migration merges legacy per-capture sessions into one day and collapses unsorted dupes', () => {
    // Simulate a pre-migration DB by writing sessions of kind=manual for "today" and "yesterday".
    const today = localDay()
    const y = new Date()
    y.setDate(y.getDate() - 1)
    const yesterday = localDay(y)
    // Use low-level inserts through createSession (kind manual), then re-run the migration function.
    const s1 = repo.createSession({ name: 'morn', kind: 'manual', createdAt: today + 'T02:00:00.000Z', tabs: [{ title: 'A', url: 'https://a.com' }] })
    const s2 = repo.createSession({
      name: 'eve',
      kind: 'auto',
      createdAt: today + 'T14:00:00.000Z',
      tabs: [
        { title: 'A2', url: 'https://www.a.com/?utm_source=1' },
        { title: 'B', url: 'https://b.com' }
      ]
    })
    const s3 = repo.createSession({ name: 'yst', kind: 'manual', createdAt: yesterday + 'T12:00:00.000Z', tabs: [{ title: 'C', url: 'https://c.com' }] })
    // Force day column empty and kind as capture-like, then run the JS migration.
    repo.db.prepare('UPDATE sessions SET day = NULL WHERE id IN (?, ?, ?)').run(s1, s2, s3)
    // Snapshot items table already exists (schema is current). Clear items so migration rebuilds them.
    repo.db.exec('DELETE FROM snapshot_items')
    mergeSessionsPerDay(repo.db)
    const daily = repo.snapshot().sessions.filter((s) => s.kind === 'daily')
    expect(daily).toHaveLength(2)
    const todaySess = daily.find((s) => s.day === today)!
    expect(todaySess.itemCount).toBe(2) // a.com + b.com
    expect(repo.snapshot().tabs.filter((t) => t.normUrl.includes('a.com'))).toHaveLength(1)
  })

  it('dayStats reports new-vs-previous-day correctly', () => {
    const y = new Date()
    y.setDate(y.getDate() - 1)
    repo.recordCapture(
      [
        { title: 'A', url: 'https://a.com', source: 'c' },
        { title: 'B', url: 'https://b.com', source: 'c' }
      ],
      y
    )
    repo.recordCapture([
      { title: 'B', url: 'https://b.com', source: 'c' },
      { title: 'C', url: 'https://c.com', source: 'c' }
    ])
    const snap = repo.snapshot()
    const today = snap.sessions.find((s) => s.day === localDay())!
    expect(today.addedCount).toBe(1) // only C is new vs yesterday
    expect(today.itemCount).toBe(2)
  })
})

describe('diffCaptures', () => {
  it('diffs by normalized URL across typed lists', () => {
    const d = diffCaptures(
      [{ url: 'https://a.com' }, { url: 'https://b.com' }],
      [
        { url: 'http://www.a.com/?utm_source=x', title: 'A' },
        { url: 'https://c.com', title: 'C' }
      ]
    )
    expect(d.kept).toHaveLength(1)
    expect(d.added.map((t) => t.title)).toEqual(['C'])
    expect(d.removed.map((t) => t.url)).toEqual(['https://b.com'])
  })
})

describe('recycle bin', () => {
  it('trash → restore keeps folder; empty purges', () => {
    repo.recordCapture([
      { title: 'A', url: 'https://a.com', source: 'c' },
      { title: 'B', url: 'https://b.com', source: 'c' }
    ])
    const [a, b] = repo.snapshot().tabs
    const folder = repo.findCollectionByName('工作')!.id
    repo.moveToCollection([a.id], folder)
    repo.updateTab(a.id, { note: '重要' })
    expect(repo.trashTabs([a.id, b.id])).toBe(2)
    let s = repo.snapshot()
    expect(s.tabs).toHaveLength(0)
    expect(s.trash.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    repo.restoreFromTrash([a.id])
    s = repo.snapshot()
    expect(s.tabs[0]).toMatchObject({ id: a.id, collectionId: folder, note: '重要' })
    expect(repo.emptyTrash()).toBe(1)
    expect(repo.snapshot().trash).toHaveLength(0)
  })
})

describe('dayCountByBrowser', () => {
  it('counts an item for every browser that had it open', () => {
    const r = new Repo(join(mkdtempSync(join(tmpdir(), 'tabnest-dc-')), 't.db'))
    r.recordCapture([
      { title: 'A', url: 'https://a.com/', browserId: 'edge', profileId: 'Default', pinned: false, lastActiveAt: null, source: 'edge::Default' },
      { title: 'A', url: 'https://a.com/', browserId: 'opera', profileId: 'Default', pinned: false, lastActiveAt: null, source: 'opera::Default' },
      { title: 'B', url: 'https://b.com/', browserId: 'opera', profileId: 'Default', pinned: false, lastActiveAt: null, source: 'opera::Default' }
    ])
    expect(r.dayCountByBrowser()).toEqual({ edge: 1, opera: 2 })
    r.close()
  })
})
