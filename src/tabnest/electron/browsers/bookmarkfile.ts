import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** First bytes look like plain JSON (Chromium Bookmarks). QQ浏览器 Bookmarks_NN is encrypted ("QBCI…"). */
export function looksLikeJson(head: Buffer): boolean {
  const t = head
    .toString('utf-8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  return t.startsWith('{')
}

function head(p: string): Buffer | null {
  try {
    const fd = openSync(p, 'r')
    try {
      const b = Buffer.alloc(16)
      const n = readSync(fd, b, 0, 16, 0)
      return b.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Candidate bookmark files of a Chromium-family profile: `Bookmarks`, then fork variants like `Bookmarks_01` (QQ浏览器). */
export function bookmarkCandidates(profile: string): string[] {
  const out: string[] = []
  if (existsSync(join(profile, 'Bookmarks'))) out.push(join(profile, 'Bookmarks'))
  try {
    for (const f of readdirSync(profile).sort()) if (/^Bookmarks_\d+$/.test(f)) out.push(join(profile, f))
  } catch {
    /* ignore */
  }
  return out
}

/** The first readable plain-JSON bookmarks file, or null (missing or encrypted/unknown format). */
export function chromiumBookmarksFile(profile: string): string | null {
  for (const p of bookmarkCandidates(profile)) {
    const h = head(p)
    if (h === null) return p // locked: let the reader try its locked-copy path
    if (looksLikeJson(h)) return p
  }
  return null
}
