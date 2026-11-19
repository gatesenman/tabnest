import { normalizeUrl } from './url'

export interface Diffable {
  url: string
}

export interface CaptureDiff<P extends Diffable = Diffable, C extends Diffable = P> {
  added: C[]
  removed: P[]
  kept: C[]
}

/** Diff two tab lists by normalized URL. `previous` is the baseline, `current` is the new capture. */
export function diffCaptures<P extends Diffable, C extends Diffable = P>(previous: P[], current: C[]): CaptureDiff<P, C> {
  const prev = new Map(previous.map((t) => [normalizeUrl(t.url), t]))
  const curr = new Map(current.map((t) => [normalizeUrl(t.url), t]))
  const added: C[] = []
  const kept: C[] = []
  const removed: P[] = []
  for (const [k, t] of curr) {
    if (prev.has(k)) kept.push(t)
    else added.push(t)
  }
  for (const [k, t] of prev) if (!curr.has(k)) removed.push(t)
  return { added, removed, kept }
}
