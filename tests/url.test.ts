import { describe, expect, it } from 'vitest'
import { defaultSessionName, ensureHttp, extractDomain, normalizeUrl, parseTabLines } from '../shared/url'

describe('normalizeUrl', () => {
  it('strips tracking params, www, hash, trailing slash and default port', () => {
    expect(normalizeUrl('https://www.Example.com:443/a/b/?utm_source=x&b=2&a=1#frag')).toBe('https://example.com/a/b?a=1&b=2')
  })
  it('treats http and https and fbclid/gclid variants as equal', () => {
    expect(normalizeUrl('http://github.com/pulls?gclid=1')).toBe(normalizeUrl('https://www.github.com/pulls/'))
  })
  it('keeps meaningful query params', () => {
    expect(normalizeUrl('https://a.com/s?q=tabs')).toBe('https://a.com/s?q=tabs')
  })
  it('handles bare origins and invalid input', () => {
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com')
    expect(normalizeUrl('  NOT A URL ')).toBe('not a url')
  })
})

describe('parseTabLines', () => {
  it('parses plain, tab-separated, pipe and markdown lines', () => {
    const r = parseTabLines('https://a.com\n标题\thttps://b.com/x\nC 站 | https://c.com\n- [D](https://d.com)\nnot a url\nexample.org/path')
    expect(r.map((x) => x.url)).toEqual(['https://a.com', 'https://b.com/x', 'https://c.com', 'https://d.com', 'https://example.org/path'])
    expect(r[1].title).toBe('标题')
    expect(r[3].title).toBe('D')
  })
  it('parses a JSON array of strings and objects, dropping non-http entries', () => {
    const r = parseTabLines(JSON.stringify(['a.com', { title: 'B', url: 'https://b.com' }, { url: 'javascript:alert(1)' }]))
    expect(r).toEqual([
      { title: 'a.com', url: 'https://a.com' },
      { title: 'B', url: 'https://b.com' }
    ])
  })
  it('returns [] for empty input', () => expect(parseTabLines('   ')).toEqual([]))
})

describe('helpers', () => {
  it('extractDomain', () => {
    expect(extractDomain('https://www.zhihu.com/q/1')).toBe('zhihu.com')
    expect(extractDomain('bad')).toBe('unknown')
  })
  it('ensureHttp', () => {
    expect(ensureHttp('a.com')).toBe('https://a.com')
    expect(ensureHttp('//a.com')).toBe('https://a.com')
    expect(ensureHttp('http://a.com')).toBe('http://a.com')
  })
  it('defaultSessionName uses Chinese day period', () => {
    expect(defaultSessionName(new Date(2026, 9, 14, 20, 5))).toBe('2026-10-14 晚上')
    expect(defaultSessionName(new Date(2026, 0, 2, 9))).toBe('2026-01-02 上午')
  })
})
