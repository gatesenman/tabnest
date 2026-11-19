import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeLz4Block, decodeMozLz4, readJsonLz4 } from '../electron/browsers/mozlz4'
import { firefoxOpenTabs, type FxSession } from '../electron/browsers/parsers'

/** Encode a single LZ4 block (literals only — fine for a round-trip of small payloads). */
function encodeLiterals(src: Buffer): Buffer {
  // token = lit<<4 | 0, then lit length extras if ≥15, then bytes. No match → end.
  const out: number[] = []
  let i = 0
  while (i < src.length) {
    const n = Math.min(src.length - i, 0xffff)
    const lit = Math.min(n, 15)
    out.push(lit << 4)
    let rem = n - lit
    while (rem >= 255) {
      out.push(255)
      rem -= 255
    }
    if (n >= 15) out.push(rem)
    for (let j = 0; j < n; j++) out.push(src[i++])
    // If more remains we'd need a dummy match; for n==src.length we're done.
    if (i < src.length) {
      // insert a 4-byte match of offset 1 so the stream continues
      out[out.length - n - 1] = (out[out.length - n - 1] & 0xf0) | 0 // keep lit, match len 0→4
      out.push(1, 0) // offset
    }
  }
  return Buffer.from(out)
}

describe('mozLz4', () => {
  it('decodes literals and overlapping matches (offset < length)', () => {
    const raw = Buffer.from('{"ok":true,"zh":"你好"}')
    expect(decodeLz4Block(encodeLiterals(raw), raw.length).toString()).toBe(raw.toString())
    // 'a' literal then match offset 1 length 6 (token low nibble 2 → 2+4) → 'aaaaaaa', then final literals 'xyz12'
    const block = Buffer.from([0x12, 0x61, 0x01, 0x00, 0x50, ...Buffer.from('xyz12')])
    expect(decodeLz4Block(block, 12).toString()).toBe('aaaaaaaxyz12')
  })

  it('reads a real Firefox recovery.jsonlz4 fixture', () => {
    const session = readJsonLz4<FxSession>(readFileSync('tests/fixtures/firefox-recovery.jsonlz4'))
    const tabs = firefoxOpenTabs(session)
    expect(tabs.length).toBeGreaterThanOrEqual(5)
    expect(tabs.map((t) => t.url).join(' ')).toMatch(/mozilla|firefox|sspai|ruanyifeng|mdn|ycombinator/i)
  })

  it('rejects bad magic and oversize claims', () => {
    expect(() => decodeMozLz4(Buffer.from('notmoz'))).toThrow(/mozLz4/)
    const hdr = Buffer.alloc(12)
    Buffer.from('mozLz40\0').copy(hdr)
    hdr.writeUInt32LE(0xffffffff, 8)
    expect(() => decodeMozLz4(hdr)).toThrow(/过大/)
  })
})
