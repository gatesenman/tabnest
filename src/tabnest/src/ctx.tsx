import { createContext, useCallback, useContext, useState } from 'react'
import type { Collection, Snapshot, TabItem } from '../shared/types'

export interface AppCtx {
  snap: Snapshot
  run: <T>(fn: () => Promise<T>, ok?: string | ((r: T) => string)) => Promise<T | undefined>
  toast: (m: string) => void
  ask: (title: string, initial?: string, placeholder?: string) => Promise<string | null>
  openUrls: (urls: string[]) => void
  checkLinks: (ids: string[]) => void
  summarize: (ids: string[]) => void
  moveTo: (ids: string[], collectionId: string | null) => Promise<void>
  pickFolderAndMove: (ids: string[]) => void
  collectionsById: Map<string, Collection>
  sessionsById: Map<string, { name: string }>
}

export const Ctx = createContext<AppCtx | null>(null)
export function useApp(): AppCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('no ctx')
  return c
}

export function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const toggle = useCallback(
    (id: string) =>
      setSel((p) => {
        const n = new Set(p)
        if (n.has(id)) n.delete(id)
        else n.add(id)
        return n
      }),
    []
  )
  const toggleMany = useCallback(
    (ids: string[], on: boolean) =>
      setSel((p) => {
        const n = new Set(p)
        for (const i of ids) {
          if (on) n.add(i)
          else n.delete(i)
        }
        return n
      }),
    []
  )
  const clear = useCallback(() => setSel(new Set()), [])
  const set = useCallback((ids: string[]) => setSel(new Set(ids)), [])
  return { sel, toggle, toggleMany, clear, set }
}

/** Selected ids still present in `tabs` (drops stale ids after moves/deletes). */
export function liveSelection(sel: Set<string>, tabs: TabItem[]): string[] {
  return tabs.filter((t) => sel.has(t.id)).map((t) => t.id)
}
