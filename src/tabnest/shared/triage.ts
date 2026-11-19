/** Pure reducer for keyboard-driven inbox triage. */

export type TriageAction =
  | { type: 'keep'; folderId: string } // → / number key
  | { type: 'later' } // → later-read
  | { type: 'discard' } // ←
  | { type: 'archive' } // E
  | { type: 'skip' } // ↓ / skip
  | { type: 'undo' } // Z

export interface TriageDecision {
  tabId: string
  action: 'keep' | 'later' | 'discard' | 'archive'
  folderId?: string
}

export interface TriageState {
  queue: string[]
  index: number
  decisions: TriageDecision[]
  done: boolean
}

export function createTriage(queue: string[]): TriageState {
  return { queue, index: 0, decisions: [], done: queue.length === 0 }
}

export function triageReducer(state: TriageState, action: TriageAction, laterFolderId: string, archiveFolderId: string): TriageState {
  if (action.type === 'undo') {
    if (!state.decisions.length) return state
    const decisions = state.decisions.slice(0, -1)
    return { ...state, decisions, index: Math.max(0, state.index - 1), done: false }
  }
  if (state.done || state.index >= state.queue.length) return { ...state, done: true }
  const tabId = state.queue[state.index]
  let decision: TriageDecision
  switch (action.type) {
    case 'keep':
      decision = { tabId, action: 'keep', folderId: action.folderId }
      break
    case 'later':
      decision = { tabId, action: 'later', folderId: laterFolderId }
      break
    case 'discard':
      decision = { tabId, action: 'discard' }
      break
    case 'archive':
      decision = { tabId, action: 'archive', folderId: archiveFolderId }
      break
    case 'skip':
      return { ...state, index: state.index + 1, done: state.index + 1 >= state.queue.length }
  }
  const decisions = [...state.decisions, decision]
  const index = state.index + 1
  return { queue: state.queue, index, decisions, done: index >= state.queue.length }
}

export function triageProgress(s: TriageState): { done: number; total: number; pct: number } {
  const done = s.decisions.length
  const total = s.queue.length
  return { done, total, pct: total ? Math.round((done / total) * 100) : 100 }
}
