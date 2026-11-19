import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '../electron/db'
import { summarizeTabs } from '../electron/ai'

let dir: string
let repo: Repo
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabnest-sum-'))
  repo = new Repo(join(dir, 't.db'))
  repo.insertTabs([
    { id: 'a', url: 'https://react.dev/learn', title: 'Quick Start – React', sessionId: null, collectionId: null },
    { id: 'b', url: 'https://github.com/vitejs/vite', title: 'vitejs/vite', sessionId: null, collectionId: null }
  ])
})
afterEach(() => {
  repo.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ai:summarize (生成摘要)', () => {
  it('runs the local engine instantly when no cloud key, writes metadata and explains why', async () => {
    const r = await summarizeTabs(repo, ['a', 'b', 'gone'], { apiKey: null, baseUrl: 'https://x/v1', model: 'm' })
    expect(r).toMatchObject({ count: 2, missing: 1, source: 'local', reason: '未配置云端 AI，已用本地引擎生成' })
    const [a] = repo.getTabs(['a']) as unknown as { summary: string; enrichedBy: string; enrichedAt: string | null }[]
    expect(a.summary).toContain('React')
    expect(a.enrichedBy).toBe('local')
    expect(a.enrichedAt).toBeTruthy()
  })
  it('reports partial cloud failure with a local fallback', async () => {
    let n = 0
    const fake = async () => {
      const base = { description: 'd', keywords: ['k'], topics: ['t'], summary: 's', lang: 'zh' }
      return n++ === 0 ? { ...base, source: 'cloud' as const } : { ...base, source: 'local' as const }
    }
    const r = await summarizeTabs(repo, ['a', 'b'], { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' }, fake)
    expect(r.source).toBe('cloud')
    expect(r.reason).toBe('云端 AI 有 1 项失败，已用本地引擎补齐')
  })
})
