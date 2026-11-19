import { isHttpUrl, extractDomain } from './url'

export interface ParsedBookmark {
  title: string
  url: string
  folder?: string
  addDate?: number
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Parse Netscape Bookmark File (Chrome / Firefox / Edge / Safari export). Folder = innermost <H3>. */
export function parseBookmarkHtml(html: string): ParsedBookmark[] {
  if (typeof html !== 'string' || !html.trim()) return []
  const results: ParsedBookmark[] = []
  const stack: string[] = []
  let pendingFolder: string | null = null
  const re = /<H3\b[^>]*>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>|<DL\b[^>]*>|<\/DL>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tok = m[0]
    if (/^<H3/i.test(tok)) {
      pendingFolder = decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()) || '未命名文件夹'
    } else if (/^<DL/i.test(tok)) {
      stack.push(pendingFolder ?? '')
      pendingFolder = null
    } else if (/^<\/DL/i.test(tok)) {
      stack.pop()
    } else {
      const attrs = m[2] ?? ''
      const href = attrs.match(/HREF\s*=\s*"([^"]*)"/i)?.[1] ?? attrs.match(/HREF\s*=\s*'([^']*)'/i)?.[1]
      const url = href ? decodeEntities(href.trim()) : ''
      if (!isHttpUrl(url)) continue
      const add = attrs.match(/ADD_DATE\s*=\s*"(\d+)"/i)?.[1]
      const folder = [...stack].reverse().find((f) => f) || undefined
      results.push({
        title: decodeEntities((m[3] ?? '').replace(/<[^>]+>/g, '').trim()) || extractDomain(url),
        url,
        folder,
        addDate: add ? Number(add) : undefined
      })
    }
  }
  return results
}

export interface ExportFolder {
  name: string
  items: { title: string; url: string; createdAt?: string }[]
}

/** Produce a Netscape bookmark file importable by every major browser. */
export function exportBookmarkHtml(folders: ExportFolder[], rootName = 'TabNest 页签巢'): string {
  const ts = (iso?: string) => Math.floor((iso ? Date.parse(iso) : Date.now()) / 1000) || Math.floor(Date.now() / 1000)
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    `    <DT><H3 ADD_DATE="${ts()}">${escapeHtml(rootName)}</H3>`,
    '    <DL><p>'
  ]
  for (const f of folders) {
    lines.push(`        <DT><H3 ADD_DATE="${ts()}">${escapeHtml(f.name)}</H3>`, '        <DL><p>')
    for (const it of f.items) {
      lines.push(`            <DT><A HREF="${escapeHtml(it.url)}" ADD_DATE="${ts(it.createdAt)}">${escapeHtml(it.title)}</A>`)
    }
    lines.push('        </DL><p>')
  }
  lines.push('    </DL><p>', '</DL><p>', '')
  return lines.join('\n')
}
