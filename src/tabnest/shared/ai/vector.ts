import { segment } from './segment'

/** Hashed bag-of-words + char-trigram embedding (local, deterministic, 256 dims, L2-normalized). */
export const VEC_DIM = 256

function fnv(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface VecInput {
  title: string
  keywords?: string[]
  topics?: string[]
  text?: string
  site?: string
}

export function embedLocal(x: VecInput): Float32Array {
  const v = new Float32Array(VEC_DIM)
  const add = (tok: string, w: number) => {
    const h = fnv(tok)
    v[h % VEC_DIM] += h & 0x80000000 ? -w : w
  }
  const words = (s: string, w: number) => {
    for (const t of segment(s)) add('w:' + t, w)
  }
  words(x.title, 1.0)
  for (const k of x.keywords ?? []) words(k, 1.2)
  for (const k of x.topics ?? []) words(k, 1.0)
  if (x.text) words(x.text.slice(0, 800), 0.35)
  // char trigrams of the title catch morphology / unknown CJK words
  const t = x.title.toLowerCase().replace(/\s+/g, ' ')
  for (let i = 0; i + 3 <= t.length; i++) add('c:' + t.slice(i, i + 3), 0.25)
  if (x.site) add('s:' + x.site, 0.6)
  return normalize(v)
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}
export function fromBlob(b: Uint8Array | null | undefined): Float32Array | null {
  if (!b || b.byteLength % 4) return null
  const copy = new Uint8Array(b.byteLength)
  copy.set(b)
  return new Float32Array(copy.buffer)
}

/** Mean of vectors (folder centroid), normalized. */
export function centroid(vs: Float32Array[]): Float32Array | null {
  if (!vs.length) return null
  const c = new Float32Array(vs[0].length)
  for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i]
  return normalize(c)
}
