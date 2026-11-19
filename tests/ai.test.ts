import { describe, expect, it } from 'vitest'
import { heuristicSummary, tokenize } from '../shared/ai-heuristic'
import { suggestFolderName } from '../shared/suggest'

describe('heuristicSummary', () => {
  it('uses domain knowledge for known sites', () => {
    const s = heuristicSummary('React 官方文档 · 快速入门', 'https://react.dev/learn', 'react.dev')
    expect(s.description).toContain('React 官方文档')
    expect(s.keywords).toEqual(expect.arrayContaining(['React', '文档']))
  })
  it('falls back to a generic Chinese description with path hints', () => {
    const s = heuristicSummary('Release notes', 'https://foo.example/blog/release-notes', 'foo.example')
    expect(s.description).toBe('来自 foo.example 的文章：Release notes')
    expect(s.keywords).toContain('文章')
    expect(s.keywords.length).toBeLessThanOrEqual(8)
  })
  it('never throws on odd input', () => {
    expect(heuristicSummary('', 'not a url', 'unknown').description).toBe('来自 unknown 的网页')
  })
})

describe('tokenize', () => {
  it('drops stop words, numbers and hash-like tokens', () => {
    expect(tokenize('GitHub - www - 123 - abcdef0123456789', 'https://x.com/docs/index.html')).toEqual(['GitHub', 'docs'])
  })
})

describe('suggestFolderName', () => {
  it('maps domains to built-in folders', () => {
    expect(suggestFolderName('github.com')).toBe('工作')
    expect(suggestFolderName('zh.wikipedia.org')).toBe('学习')
    expect(suggestFolderName('bilibili.com')).toBe('稍后阅读')
    expect(suggestFolderName('random.site')).toBe('未分类')
  })
})
