import { describe, expect, it } from 'vitest'
import { exportBookmarkHtml, parseBookmarkHtml } from '../shared/bookmarks'

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000000">GitHub</A>
        <DT><H3>前端</H3>
        <DL><p>
            <DT><A HREF="https://react.dev/learn">React &amp; 文档</A>
            <DT><A HREF="javascript:void(0)">bookmarklet</A>
        </DL><p>
        <DT><A HREF="https://vitejs.dev/">Vite</A>
    </DL><p>
    <DT><A HREF="https://example.com/">Top level</A>
</DL><p>`

describe('parseBookmarkHtml', () => {
  it('parses nested folders and keeps the innermost folder name', () => {
    const r = parseBookmarkHtml(CHROME_EXPORT)
    expect(r).toHaveLength(4)
    expect(r[0]).toMatchObject({ title: 'GitHub', url: 'https://github.com/', folder: '书签栏', addDate: 1700000000 })
    expect(r[1]).toMatchObject({ title: 'React & 文档', folder: '前端' })
    expect(r[2]).toMatchObject({ title: 'Vite', folder: '书签栏' })
    expect(r[3].folder).toBeUndefined()
  })
  it('skips non-http links and tolerates garbage', () => {
    expect(parseBookmarkHtml('<html>nothing here</html>')).toEqual([])
    expect(parseBookmarkHtml('')).toEqual([])
    expect(parseBookmarkHtml('<A HREF="https://a.com">unclosed <DL>')).toEqual([])
  })
})

describe('exportBookmarkHtml', () => {
  it('round-trips through the parser with folders and escaped titles', () => {
    const html = exportBookmarkHtml([
      { name: '工作', items: [{ title: 'A <b> & "c"', url: 'https://a.com/?x=1&y=2' }] },
      { name: '学习', items: [{ title: 'B', url: 'https://b.com' }] }
    ])
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
    const back = parseBookmarkHtml(html)
    expect(back).toEqual([
      expect.objectContaining({ title: 'A <b> & "c"', url: 'https://a.com/?x=1&y=2', folder: '工作' }),
      expect.objectContaining({ title: 'B', url: 'https://b.com', folder: '学习' })
    ])
  })
})
