import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, INVOKE_CHANNELS, invokeSchemas } from '../shared/ipc'

describe('IPC contract', () => {
  it('preload whitelist matches the shared contract exactly', () => {
    const src = readFileSync('electron/preload.ts', 'utf-8')
    const list = (name: string) => [...src.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\] as const`))![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(list('INVOKE_WHITELIST').sort()).toEqual([...INVOKE_CHANNELS].sort())
    expect(list('EVENT_WHITELIST').sort()).toEqual([...EVENT_CHANNELS].sort())
  })
  it('rejects non-http URLs and oversized/invalid payloads', () => {
    expect(invokeSchemas['open:urls'].safeParse({ urls: ['file:///etc/passwd'] }).success).toBe(false)
    expect(invokeSchemas['open:urls'].safeParse({ urls: ['https://ok.com'] }).success).toBe(true)
    expect(invokeSchemas['session:create'].safeParse({ name: '', tabs: [] }).success).toBe(false)
    expect(invokeSchemas['settings:update'].safeParse({ linkCheckConcurrency: 999 }).success).toBe(false)
    expect(invokeSchemas['tabs:moveToCollection'].safeParse({ tabIds: ['a'], collectionId: null }).success).toBe(true)
  })
})
