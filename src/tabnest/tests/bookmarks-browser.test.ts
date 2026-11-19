import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { countBookmarks, parseChromiumBookmarks, readFirefoxBookmarks } from '../electron/browsers/parsers'

describe('browser bookmark readers', () => {
  it('parses Chromium Bookmarks JSON preserving nested folders', () => {
    const tree = parseChromiumBookmarks(readFileSync('tests/fixtures/chromium-Bookmarks.json', 'utf-8'))
    expect(tree.map((t) => t.title)).toEqual(['书签栏', '其他书签'])
    const front = tree[0].children!.find((c) => c.title === '前端')!
    expect(front.children!.map((c) => c.title)).toEqual(['React', 'Vite', '文档'])
    expect(countBookmarks(tree)).toBe(5)
  })

  it('reads Firefox places.sqlite bookmarks by root GUID', () => {
    const tree = readFirefoxBookmarks('tests/fixtures/firefox-places.sqlite')
    type N = { title: string; children?: N[] }
    const flat = (ns: N[]): string[] => ns.flatMap((n) => [n.title, ...flat(n.children ?? [])])
    const names = flat(tree)
    expect(names).toEqual(expect.arrayContaining(['书签工具栏', '前端', 'React', 'Vite', 'Mozilla']))
    expect(countBookmarks(tree)).toBeGreaterThanOrEqual(4)
  })
})
