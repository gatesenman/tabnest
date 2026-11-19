import type { Collection, Session, SnapshotItem, TabItem } from './types'

export type Lifecycle = 'new' | 'ongoing' | 'closed' | 'organized' | 'archived'
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  new: '新出现',
  ongoing: '持续打开',
  closed: '已关闭',
  organized: '已整理',
  archived: '已归档'
}

export interface LifecycleIndex {
  /** latest local day that has a daily snapshot */
  latestDay: string | null
  /** day before latestDay that has a snapshot */
  prevDay: string | null
  status: Map<string, Lifecycle>
  days: Map<string, string[]>
  /** in prevDay, not in latestDay, not organized: accidental-loss recovery */
  disappeared: string[]
}

export function archiveFolderIds(collections: Collection[]): Set<string> {
  const root = collections.find((c) => c.builtin && c.name === '归档') ?? collections.find((c) => c.name === '归档' && !c.parentId)
  const out = new Set<string>()
  if (!root) return out
  const walk = (id: string) => {
    out.add(id)
    for (const c of collections) if (c.parentId === id) walk(c.id)
  }
  walk(root.id)
  return out
}

export function buildLifecycle(tabs: TabItem[], sessions: Session[], items: SnapshotItem[], collections: Collection[]): LifecycleIndex {
  const dayOf = new Map(sessions.filter((s) => s.kind === 'daily' && s.day).map((s) => [s.id, s.day!]))
  const allDays = [...new Set(dayOf.values())].sort()
  const latestDay = allDays.at(-1) ?? null
  const prevDay = allDays.at(-2) ?? null
  const days = new Map<string, string[]>()
  for (const it of items) {
    const d = dayOf.get(it.sessionId)
    if (!d) continue
    const arr = days.get(it.tabId) ?? []
    if (!arr.includes(d)) arr.push(d)
    days.set(it.tabId, arr)
  }
  for (const t of tabs) if (!days.has(t.id) && t.sessionId && dayOf.has(t.sessionId)) days.set(t.id, [dayOf.get(t.sessionId)!])
  const archive = archiveFolderIds(collections)
  const status = new Map<string, Lifecycle>()
  const disappeared: string[] = []
  for (const t of tabs) {
    const ds = (days.get(t.id) ?? []).sort()
    if (t.collectionId) status.set(t.id, archive.has(t.collectionId) ? 'archived' : 'organized')
    else if (!ds.length) status.set(t.id, 'closed')
    else if (ds.at(-1) !== latestDay) status.set(t.id, 'closed')
    else status.set(t.id, ds.length >= 2 ? 'ongoing' : 'new')
    if (!t.collectionId && prevDay && ds.includes(prevDay) && !ds.includes(latestDay!)) disappeared.push(t.id)
  }
  return { latestDay, prevDay, status, days, disappeared }
}
