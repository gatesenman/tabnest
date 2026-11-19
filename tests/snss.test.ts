import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PickleReader, parseSession, readCommands, SESSION_CMD } from '../electron/browsers/snss'

/** Build a tiny SNSS buffer: header + commands. Payload for UpdateTabNavigation is a Pickle. */
function pickle(...parts: (number | string | { s16: string })[]): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    if (typeof p === 'number') {
      const b = Buffer.alloc(4)
      b.writeInt32LE(p)
      chunks.push(b)
    } else if (typeof p === 'string') {
      const raw = Buffer.from(p, 'utf8')
      const len = Buffer.alloc(4)
      len.writeInt32LE(raw.length)
      const pad = Buffer.alloc((4 - (raw.length % 4)) % 4)
      chunks.push(len, raw, pad)
    } else {
      const raw = Buffer.from(p.s16, 'utf16le')
      const len = Buffer.alloc(4)
      len.writeInt32LE(p.s16.length)
      const pad = Buffer.alloc((4 - (raw.length % 4)) % 4)
      chunks.push(len, raw, pad)
    }
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

function cmd(id: number, payload: Buffer): Buffer {
  const size = Buffer.alloc(2)
  size.writeUInt16LE(payload.length + 1)
  return Buffer.concat([size, Buffer.from([id]), payload])
}

function i32(...ns: number[]): Buffer {
  const b = Buffer.alloc(ns.length * 4)
  ns.forEach((n, i) => b.writeInt32LE(n, i * 4))
  return b
}

function snss(...commands: Buffer[]): Buffer {
  const magic = Buffer.from('SNSS')
  const ver = Buffer.alloc(4)
  ver.writeInt32LE(3)
  return Buffer.concat([magic, ver, ...commands])
}

describe('SNSS parser', () => {
  it('reads the real Chromium 1248 fixture (2 windows, 13 tabs)', () => {
    const buf = readFileSync('tests/fixtures/chromium-1248.Session')
    const { version, commands } = readCommands(buf)
    expect(version).toBe(3)
    expect(commands.some((c) => c.id === SESSION_CMD.UpdateTabNavigation)).toBe(true)
    const wins = parseSession(buf)
    expect(wins.length).toBe(2)
    const tabs = wins.flatMap((w) => w.tabs)
    expect(tabs.length).toBeGreaterThanOrEqual(12)
    expect(tabs.map((t) => t.url)).toEqual(
      expect.arrayContaining(['https://github.com/electron/electron', 'https://www.bilibili.com/', 'https://react.dev/learn'])
    )
    expect(tabs.find((t) => t.url.includes('github'))?.title).toMatch(/electron/i)
  })

  it('reconstructs windows, pinned state, closed tabs and pruned history from a synthetic file', () => {
    const nav = (tab: number, idx: number, url: string, title: string) => cmd(SESSION_CMD.UpdateTabNavigation, pickle(tab, idx, url, { s16: title }))
    const buf = snss(
      cmd(SESSION_CMD.SetTabWindow, i32(1, 10)),
      cmd(SESSION_CMD.SetTabIndexInWindow, i32(10, 0)),
      cmd(SESSION_CMD.SetPinnedState, Buffer.concat([i32(10), Buffer.from([1])])),
      nav(10, 0, 'https://a.com/', 'A'),
      cmd(SESSION_CMD.SetSelectedNavigationIndex, i32(10, 0)),
      cmd(SESSION_CMD.SetTabWindow, i32(1, 11)),
      cmd(SESSION_CMD.SetTabIndexInWindow, i32(11, 1)),
      nav(11, 0, 'https://b.com/old', 'old'),
      nav(11, 1, 'https://b.com/new', 'B'),
      cmd(SESSION_CMD.SetSelectedNavigationIndex, i32(11, 1)),
      cmd(SESSION_CMD.TabNavigationPathPruned, i32(11, 0, 1)), // drop index 0; 1 → 0
      cmd(SESSION_CMD.SetSelectedNavigationIndex, i32(11, 0)),
      cmd(SESSION_CMD.SetTabWindow, i32(1, 12)),
      nav(12, 0, 'https://gone.com/', 'Gone'),
      cmd(SESSION_CMD.TabClosed, i32(12)),
      cmd(SESSION_CMD.SetSelectedTabInIndex, i32(1, 0))
    )
    const [w] = parseSession(buf)
    expect(w.tabs.map((t) => ({ url: t.url, pinned: t.pinned, title: t.title }))).toEqual([
      { url: 'https://a.com/', pinned: true, title: 'A' },
      { url: 'https://b.com/new', pinned: false, title: 'B' }
    ])
  })

  it('rejects non-SNSS and tolerates a truncated trailing command', () => {
    expect(() => readCommands(Buffer.from('nope'))).toThrow(/SNSS/)
    const good = snss(cmd(SESSION_CMD.SetTabWindow, i32(1, 1)))
    const truncated = Buffer.concat([good, Buffer.from([10, 0])]) // size=10 but no payload
    expect(readCommands(truncated).commands).toHaveLength(1)
  })

  it('PickleReader aligns string payloads', () => {
    const r = new PickleReader(pickle(7, 'hi', { s16: '中' }))
    expect(r.int()).toBe(7)
    expect(r.string()).toBe('hi')
    expect(r.string16()).toBe('中')
  })
})
