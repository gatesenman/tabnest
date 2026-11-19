/**
 * Firefox "mozLz40" container: 8-byte magic "mozLz40\0", uint32 LE decompressed size, then one raw LZ4 block.
 * Pure-JS LZ4 block decoder (no native modules, works on every platform).
 */
const MAGIC = 'mozLz40\0'

export function decodeLz4Block(src: Uint8Array, outSize: number): Buffer {
  const out = Buffer.allocUnsafe(outSize)
  let s = 0
  let d = 0
  while (s < src.length) {
    const token = src[s++]
    let lit = token >>> 4
    if (lit === 15) {
      let b: number
      do {
        b = src[s++]
        lit += b
      } while (b === 255 && s < src.length)
    }
    if (s + lit > src.length || d + lit > outSize) throw new Error('lz4: literal overrun')
    out.set(src.subarray(s, s + lit), d)
    s += lit
    d += lit
    if (s >= src.length) break // last sequence has literals only
    const offset = src[s] | (src[s + 1] << 8)
    s += 2
    if (offset === 0 || offset > d) throw new Error('lz4: bad match offset')
    let len = (token & 15) + 4
    if ((token & 15) === 15) {
      let b: number
      do {
        b = src[s++]
        len += b
      } while (b === 255 && s < src.length)
    }
    if (d + len > outSize) throw new Error('lz4: match overrun')
    // Byte-by-byte copy handles overlapping matches (offset < len).
    for (let i = 0; i < len; i++, d++) out[d] = out[d - offset]
  }
  return d === outSize ? out : out.subarray(0, d)
}

export function decodeMozLz4(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('不是 mozLz4 文件')
  const size = buf.readUInt32LE(8)
  if (size > 512 * 1024 * 1024) throw new Error('mozLz4: 文件过大')
  return decodeLz4Block(buf.subarray(12), size)
}

export function readJsonLz4<T = unknown>(buf: Buffer): T {
  return JSON.parse(decodeMozLz4(buf).toString('utf8')) as T
}
