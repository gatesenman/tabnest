import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '../electron/db'
import { AutoOrganizer, type OrgSettings } from '../electron/autoorg'

let dir: string
let repo: Repo
let cfg: OrgSettings
let org: AutoOrganizer
const add = (url: string, title = url, collectionId: string | null = null) => {
  const id = `t${Math.random().toString(36).slice(2)}`
  repo.insertTabs([{ id, url, title, sessionId: null, collectionId }])
  return id
}
const folderOf = (id: string) => {
  const t = repo.getTabs([id])[0]
  return t.collectionId ? repo.collectionRow(t.collectionId)?.name : null
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabnest-org-'))
  repo = new Repo(join(dir, 't.db'))
  cfg = { autoOrganize: true, autoOrganizeThreshold: 0.75, aiCloudOrganize: false, aiBaseUrl: 'https://x/v1', aiModel: 'm' }
  org = new AutoOrganizer(
    repo,
    () => cfg,
    () => {}
  )
})
afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('AutoOrganizer', () => {
  it('auto-classifies confident tabs, keeps low-confidence ones in 未整理 as suggestions, and undoes', async () => {
    const gh = add('https://github.com/a/b', 'a/b')
    const bili = add('https://www.bilibili.com/video/BV1', '视频')
    const vague = add('https://foo.example/x', '大模型 RAG 入门')
    const unknown = add('https://zzz.example/', 'hello')
    const r = await org.organize()
    expect(r.moved).toBe(2)
    expect(folderOf(gh)).toBe('代码托管')
    expect(repo.collectionRow(repo.collectionRow(repo.getTabs([gh])[0].collectionId!)!.parentId!)!.name).toBe('开发')
    expect(folderOf(bili)).toBe('视频')
    expect(folderOf(vague)).toBeNull()
    expect(folderOf(unknown)).toBeNull()
    expect(org.status().pending.map((p) => p.tabId)).toEqual([vague])
    const [entry] = org.status().log
    expect(entry.kind).toBe('classify')
    expect(org.undo(entry.id)).toBe(true)
    expect(folderOf(gh)).toBeNull()
    expect(repo.snapshot().collections.some((c) => c.name === '代码托管' || c.name === '开发')).toBe(false)
    expect(org.undo(entry.id)).toBe(false)
  })

  it('does nothing automatically when 自动整理 is off', async () => {
    cfg.autoOrganize = false
    add('https://github.com/a/b')
    expect((await org.organize()).moved).toBe(0)
    expect(org.status().pending).toHaveLength(1)
  })

  it('learns from a manual correction and applies it to new tabs', async () => {
    const work = repo.snapshot().collections.find((c) => c.name === '工作')!.id
    const a = add('https://github.com/acme/x')
    repo.moveToCollection([a], work)
    org.learn([a], work)
    const b = add('https://github.com/acme/y')
    await org.organize()
    expect(folderOf(b)).toBe('工作')
    expect(org.status().rules[0]).toMatchObject({ kind: 'domain', match: 'github.com', folderName: '工作' })
  })

  it('applies taxonomy merge and undo restores the deleted folder', () => {
    const big = repo.createCollection('代码')
    const small = repo.createCollection('代码仓库')
    for (const i of [1, 2, 3]) add(`https://github.com/r${i}`, `r${i}`, big)
    const lone = add('https://github.com/r9', 'r9', small)
    const ops = org.review(true)
    expect(ops.some((o) => o.kind === 'merge')).toBe(true)
    expect(folderOf(lone)).toBe('代码')
    expect(repo.collectionRow(small)).toBeNull()
    const merge = org.status().log.find((e) => e.kind === 'merge')!
    org.undo(merge.id)
    expect(repo.collectionRow(small)?.name).toBe('代码仓库')
    expect(folderOf(lone)).toBe('代码仓库')
  })

  it('undo-all-today reverts every automatic change of the day', async () => {
    add('https://github.com/a/b')
    add('https://www.notion.so/page')
    await org.organize()
    const f = repo.createCollection('新建文件夹')
    for (const i of [1, 2, 3]) add(`https://www.bilibili.com/video/${i}`, `v${i}`, f)
    org.review(true)
    expect(repo.collectionRow(f)?.name).toBe('视频')
    expect(org.undoToday()).toBeGreaterThanOrEqual(2)
    expect(repo.collectionRow(f)?.name).toBe('新建文件夹')
    expect(repo.snapshot().tabs.filter((t) => !t.collectionId)).toHaveLength(2)
  })

  it('uses the cloud engine only when enabled, and caches results', async () => {
    let calls = 0
    const cloud = async (batch: { i: number }[]) => (calls++, batch.map((b) => ({ i: b.i, folder: '研究/笔记', confidence: 0.9 })))
    org = new AutoOrganizer(
      repo,
      () => cfg,
      () => {},
      () => cloud
    )
    const t = add('https://zzz.example/', 'hello')
    await org.organize()
    expect(calls).toBe(0)
    expect(folderOf(t)).toBeNull()
    cfg.aiCloudOrganize = true
    await org.organize()
    expect(calls).toBe(1)
    expect(folderOf(t)).toBe('笔记')
    org.undoToday()
    await org.organize()
    expect(calls).toBe(1) // cached
  })

  it('background descriptions are local unless cloud is enabled', async () => {
    add('https://github.com/a/b', 'a/b')
    let cloudCalls = 0
    expect(await org.describeSome(10, async () => (cloudCalls++, { description: 'x', keywords: [] }))).toBe(1)
    expect(cloudCalls).toBe(0)
    expect(repo.snapshot().tabs[0].description).toMatch(/GitHub/)
  })
})

describe('AutoOrganizer — existing bookmarks (v1.3.1)', () => {
  it('re-sorts an imported bookmark into the AI folder, logs it as a bookmark move, and undo restores its folder', async () => {
    const root = repo.createCollection('Chrome 书签', '从 Chrome 导入，保留原有文件夹结构')
    repo.importBookmarkTree([{ title: '杂项', children: [{ title: 'b/c', url: 'https://github.com/b/c' }] }], root)
    const id = repo.importedBookmarkIds()[0]
    expect(id).toBeTruthy()
    const before = folderOf(id)
    expect(before).toBe('杂项')
    const r = await org.organize('import')
    expect(r.moved).toBe(1)
    expect(folderOf(id)).not.toBe('杂项')
    expect(repo.importedBookmarkIds()).not.toContain(id)
    const e = repo.orgLog(5)[0]
    expect(e.data.target).toBe('bookmark')
    expect(e.summary).toContain('已收藏网址')
    expect(org.undo(e.id)).toBe(true)
    expect(folderOf(id)).toBe('杂项')
    expect(repo.importedBookmarkIds()).toContain(id)
  })

  it('manually placed bookmarks are left alone; low confidence imported ones become bookmark suggestions when auto is off', async () => {
    const mine = repo.createCollection('我的')
    const m = add('https://github.com/x/y', 'x/y', mine)
    repo.setPlacedBy([m], 'user')
    const root = repo.createCollection('Edge 书签', '从 Edge 导入，保留原有文件夹结构')
    repo.importBookmarkTree([{ title: 'gh', url: 'https://github.com/q/w' }], root)
    cfg.autoOrganize = false
    await org.organize('manual')
    expect(folderOf(m)).toBe('我的')
    const st = org.status()
    expect(st.pending.some((p) => p.kind === 'bookmark')).toBe(true)
  })

  it('taxonomy merge moves existing bookmarks along with the folder, undo restores', () => {
    const a = repo.createCollection('A')
    const b = repo.createCollection('B')
    const bm = add('https://example.com/1', 'one', a)
    const data = { moves: repo.moveWithHistory([bm], b), created: [], deleted: [], renamed: [] }
    const id = repo.logOrg('merge', 'merge A → B', data)
    expect(folderOf(bm)).toBe('B')
    repo.undoOrg(id)
    expect(folderOf(bm)).toBe('A')
  })
})
