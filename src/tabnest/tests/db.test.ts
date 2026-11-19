import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, Repo } from '../electron/db'

let dir: string
let repo: Repo
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabnest-test-'))
  repo = new Repo(join(dir, 't.db'))
})
afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

const folder = (name: string) => repo.findCollectionByName(name)!.id

describe('Repo', () => {
  it('migrates to the latest schema and creates built-in folders', () => {
    expect(repo.schemaVersion).toBe(MIGRATIONS.length)
    expect(repo.snapshot().collections.map((c) => c.name)).toEqual(['稍后阅读', '工作', '学习', '归档', '未分类'])
    repo.close()
    repo = new Repo(join(dir, 't.db')) // reopen is idempotent
    expect(repo.snapshot().collections).toHaveLength(5)
  })

  it('creates sessions, moves tabs to folders and back, and deletes safely', () => {
    const sid = repo.createSession({
      name: 'S',
      tabs: [
        { title: 'A', url: 'https://a.com' },
        { title: 'B', url: 'https://b.com/x' }
      ]
    })
    const [a, b] = repo.snapshot().tabs
    expect(a.domain).toBe('a.com')
    repo.moveToCollection([a.id], folder('工作'))
    expect(repo.getTabs([a.id])[0].collectionId).toBe(folder('工作'))
    expect(() => repo.moveToCollection([a.id], 'nope')).toThrow()
    repo.deleteSession(sid)
    const left = repo.snapshot().tabs
    expect(left.map((t) => t.id)).toEqual([a.id]) // organized tab survives, unsorted one is gone
    expect(left[0].sessionId).toBeNull()
    expect(repo.getTabs([b.id])).toEqual([])
  })

  it('protects built-in folders and returns items to 未整理 on clear/delete', () => {
    expect(() => repo.deleteCollection(folder('工作'))).toThrow(/内置/)
    const cid = repo.createCollection('旅行')
    repo.createSession({ name: 'S', tabs: [{ title: 'A', url: 'https://a.com' }] })
    const [t] = repo.snapshot().tabs
    repo.moveToCollection([t.id], cid)
    repo.deleteCollection(cid)
    expect(repo.getTabs([t.id])[0].collectionId).toBeNull()
  })

  it('full-text searches title/url/description/keywords, including Chinese', () => {
    repo.createSession({
      name: 'S',
      tabs: [
        { title: '如何高效管理浏览器标签', url: 'https://zhihu.com/q/1' },
        { title: 'Vite Guide', url: 'https://vitejs.dev/guide' }
      ]
    })
    const [, vite] = repo.snapshot().tabs
    repo.setSummary(vite.id, '前端构建工具文档', ['bundler', '构建'])
    expect(repo.search('浏览器标签').map((t) => t.title)).toEqual(['如何高效管理浏览器标签'])
    expect(repo.search('vitejs').map((t) => t.id)).toEqual([vite.id])
    expect(repo.search('bundler').map((t) => t.id)).toEqual([vite.id])
    expect(repo.search('构建').map((t) => t.id)).toEqual([vite.id]) // <3 chars → LIKE fallback
    expect(repo.search('"; DROP TABLE tabs; --')).toEqual([])
    expect(repo.search('')).toEqual([])
  })

  it('finds duplicates by normalized URL and merges them keeping metadata', () => {
    repo.createSession({ name: 'S1', tabs: [{ title: 'GH', url: 'https://github.com/pulls' }] })
    repo.createSession({
      name: 'S2',
      tabs: [
        { title: 'GH2', url: 'http://www.github.com/pulls/?utm_source=x' },
        { title: 'other', url: 'https://other.com' }
      ]
    })
    const [g] = repo.findDuplicates()
    expect(g.tabs).toHaveLength(2)
    const [keep, drop] = g.tabs
    repo.setSummary(drop.id, 'desc', ['k'])
    repo.moveToCollection([drop.id], folder('工作'))
    repo.mergeDuplicates(
      keep.id,
      g.tabs.map((t) => t.id)
    )
    expect(repo.findDuplicates()).toEqual([])
    const merged = repo.getTabs([keep.id])[0]
    expect(merged).toMatchObject({ description: 'desc', keywords: ['k'], collectionId: folder('工作') })
    expect(() => repo.mergeDuplicates(keep.id, [repo.snapshot().tabs.find((t) => t.title === 'other')!.id])).toThrow()
  })

  it('handles 10,000 tabs quickly', () => {
    const tabs = Array.from({ length: 10000 }, (_, i) => ({ title: `Tab ${i}`, url: `https://site${i % 300}.com/p/${i}` }))
    const t0 = performance.now()
    repo.createSession({ name: 'Big', tabs })
    const snap = repo.snapshot()
    expect(snap.tabs).toHaveLength(10000)
    expect(repo.search('site42.com/p/9042').length).toBe(1)
    expect(performance.now() - t0).toBeLessThan(5000)
  })

  it('exports and re-imports a backup into a fresh database', () => {
    repo.createSession({ name: 'S', tabs: [{ title: 'A', url: 'https://a.com' }] })
    const [t] = repo.snapshot().tabs
    repo.moveToCollection([t.id], repo.createCollection('自定义'))
    const backup = JSON.parse(JSON.stringify(repo.exportAll()))
    const other = new Repo(join(dir, 'other.db'))
    expect(other.importBackup(backup)).toBe(1)
    expect(other.importBackup(backup)).toBe(0) // idempotent
    const tab = other.snapshot().tabs[0]
    expect(other.snapshot().collections.find((c) => c.id === tab.collectionId)?.name).toBe('自定义')
    expect(() => other.importBackup({ foo: 1 })).toThrow()
    other.close()
  })

  it('imports the legacy 0.x JSON store', () => {
    const legacy = {
      sessions: [
        {
          name: 'old',
          createdAt: '2026-10-01T00:00:00Z',
          tabs: [
            { title: 'A', url: 'https://a.com', organized: true, collectionId: 'c1' },
            { title: 'B', url: 'https://b.com' }
          ]
        }
      ],
      collections: [
        {
          id: 'c1',
          name: '稍后阅读',
          tabs: [
            { title: 'A', url: 'https://a.com' },
            { title: 'Z', url: 'https://z.com' }
          ]
        }
      ]
    }
    expect(repo.importLegacyJson(legacy)).toBe(3)
    const snap = repo.snapshot()
    expect(snap.tabs).toHaveLength(3)
    expect(
      snap.tabs
        .filter((t) => t.collectionId === folder('稍后阅读'))
        .map((t) => t.title)
        .sort()
    ).toEqual(['A', 'Z'])
    expect(() => repo.importLegacyJson(null)).toThrow()
  })
})
