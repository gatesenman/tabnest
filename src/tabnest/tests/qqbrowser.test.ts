import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSession, parseRecentlyClosed } from '../electron/browsers/snss'
import { browserSpecs } from '../electron/browsers/paths'
import { chromiumBookmarksFile, looksLikeJson } from '../electron/browsers/bookmarkfile'
import { listSessionFiles, pickChromiumSession } from '../electron/browsers/read'

const dir = join(__dirname, 'fixtures', 'qqbrowser')
const TABS = join(dir, 'Tabs_13436385271714441')

describe('QQ浏览器 (real sample from Windows PC)', () => {
  it('is in the Windows discovery table with its paths', () => {
    const s = browserSpecs('win32').find((b) => b.id === 'qqbrowser')!
    expect(s.name).toBe('QQ浏览器')
    expect(s.family).toBe('chromium')
    expect(s.roots[0]).toMatch(/Tencent[\\/]QQBrowser[\\/]User Data$/)
    expect(s.exe!.some((e) => /QQBrowser\.exe$/.test(e))).toBe(true)
    for (const id of ['360se', '360chrome', 'sogou', '2345', 'liebao', 'quark', 'lenovo']) expect(browserSpecs('win32').some((b) => b.id === id)).toBe(true)
  })

  it('Tabs_ file is a real SNSS v3 TabRestore file: recently-closed parse, no live windows', () => {
    const buf = readFileSync(TABS)
    expect(buf.toString('latin1', 0, 4)).toBe('SNSS')
    expect(parseSession(buf)).toEqual([])
    const closed = parseRecentlyClosed(buf)
    expect(closed.length).toBeGreaterThan(10)
    expect(closed.every((n) => typeof n.url === 'string')).toBe(true)
  })

  it('live Session_ locked → marked locked/stale, falls back to Tabs_ recently-closed', () => {
    const p = mkdtempSync(join(tmpdir(), 'qqb-'))
    mkdirSync(join(p, 'Sessions'))
    copyFileSync(TABS, join(p, 'Sessions', 'Tabs_13436385271714441'))
    writeFileSync(join(p, 'Sessions', 'Session_13436461344955646'), Buffer.alloc(0))
    const now = Date.now() / 1000
    utimesSync(join(p, 'Sessions', 'Tabs_13436385271714441'), now - 3600, now - 3600)
    const files = listSessionFiles(p)
    expect(files[0].kind).toBe('session')
    const r = pickChromiumSession(files, (f) => (f.kind === 'session' ? null : readFileSync(f.path)))
    expect(r.locked).toBe(true)
    expect(r.closed.length).toBeGreaterThan(10)
  })

  it('legacy Last Session / Last Tabs names are listed', () => {
    const p = mkdtempSync(join(tmpdir(), 'qqb-'))
    writeFileSync(join(p, 'Last Session'), 'SNSS')
    writeFileSync(join(p, 'Last Tabs'), 'SNSS')
    expect(
      listSessionFiles(p)
        .map((f) => f.kind)
        .sort()
    ).toEqual(['session', 'tabs'])
  })

  it('encrypted Bookmarks_01 (QBCI…) is detected and skipped; plain Bookmarks_01 used', () => {
    const enc = readFileSync(join(dir, 'Bookmarks_01'))
    expect(looksLikeJson(enc)).toBe(false)
    const p = mkdtempSync(join(tmpdir(), 'qqb-'))
    writeFileSync(join(p, 'Bookmarks_01'), enc)
    expect(chromiumBookmarksFile(p)).toBeNull()
    writeFileSync(join(p, 'Bookmarks_02'), '{"roots":{}}')
    expect(chromiumBookmarksFile(p)).toBe(join(p, 'Bookmarks_02'))
  })

  it('Local State lists the Default profile', () => {
    const ls = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf-8'))
    expect(Object.keys(ls.profile.info_cache)).toContain('Default')
  })
})
