import { describe, expect, it } from 'vitest'
import { createTriage, triageProgress, triageReducer } from '../shared/triage'

describe('triage reducer', () => {
  it('walks the queue with keep / later / discard / archive / skip / undo', () => {
    let s = createTriage(['a', 'b', 'c', 'd'])
    s = triageReducer(s, { type: 'keep', folderId: 'work' }, 'later', 'arch')
    s = triageReducer(s, { type: 'later' }, 'later', 'arch')
    s = triageReducer(s, { type: 'skip' }, 'later', 'arch')
    s = triageReducer(s, { type: 'discard' }, 'later', 'arch')
    expect(s.done).toBe(true)
    expect(s.decisions).toEqual([
      { tabId: 'a', action: 'keep', folderId: 'work' },
      { tabId: 'b', action: 'later', folderId: 'later' },
      { tabId: 'd', action: 'discard' }
    ])
    expect(triageProgress(s)).toEqual({ done: 3, total: 4, pct: 75 })
    s = triageReducer(s, { type: 'undo' }, 'later', 'arch')
    expect(s.done).toBe(false)
    expect(s.index).toBe(3)
    expect(s.decisions).toHaveLength(2)
  })

  it('marks empty queues done immediately', () => {
    expect(createTriage([]).done).toBe(true)
  })
})
