import { useEffect, useReducer } from 'react'
import { createTriage, triageProgress, triageReducer, type TriageAction } from '../../shared/triage'
import type { Collection, TabItem } from '../../shared/types'
import { Modal } from '../components/Modals'

/** Compact keyboard triage: 1–9 folder · L 稍后 · A 归档 · D 丢弃 · S 跳过 · U 撤销. Applied on 确定. */
export function TriageDialog({
  tabs,
  collections,
  onClose,
  onCommit
}: {
  tabs: TabItem[]
  collections: Collection[]
  onClose: () => void
  onCommit: (moves: { ids: string[]; folderId: string }[], discard: string[]) => void
}) {
  const later = collections.find((c) => c.name === '稍后阅读')?.id ?? collections[0]?.id ?? ''
  const archive = collections.find((c) => c.name === '归档')?.id ?? later
  const [st, dispatch] = useReducer(
    (s: ReturnType<typeof createTriage>, a: TriageAction) => triageReducer(s, a, later, archive),
    tabs.map((t) => t.id),
    createTriage
  )
  const cur = tabs.find((t) => t.id === st.queue[st.index])
  const pg = triageProgress(st)
  const folders = collections.slice(0, 9)

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return
      const n = Number(e.key)
      if (n >= 1 && n <= folders.length) dispatch({ type: 'keep', folderId: folders[n - 1].id })
      else if (e.key === 'l') dispatch({ type: 'later' })
      else if (e.key === 'a') dispatch({ type: 'archive' })
      else if (e.key === 'd' || e.key === 'Delete') dispatch({ type: 'discard' })
      else if (e.key === 's' || e.key === 'ArrowRight') dispatch({ type: 'skip' })
      else if (e.key === 'u' || (e.key === 'z' && e.ctrlKey)) dispatch({ type: 'undo' })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [folders])

  const commit = () => {
    const byFolder = new Map<string, string[]>()
    const discard: string[] = []
    for (const d of st.decisions) {
      if (d.action === 'discard') discard.push(d.tabId)
      else if (d.folderId) byFolder.set(d.folderId, [...(byFolder.get(d.folderId) ?? []), d.tabId])
    }
    onCommit(
      [...byFolder].map(([folderId, ids]) => ({ folderId, ids })),
      discard
    )
  }

  return (
    <Modal
      title={`快速整理 — ${pg.done}/${pg.total}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} disabled={!st.decisions.length} onClick={() => dispatch({ type: 'undo' })}>
            撤销 (U)
          </button>
          <button className="btn btn-primary" onClick={commit}>
            确定（应用 {st.decisions.length} 项）
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <div className="sb-bar wide">
        <span style={{ width: `${pg.pct}%` }} />
      </div>
      {cur ? (
        <div className="triage-item">
          <b>{cur.title}</b>
          <div className="dim">{cur.url}</div>
          {cur.description && <p className="muted">{cur.description}</p>}
        </div>
      ) : (
        <p>全部处理完了，点「确定」应用。</p>
      )}
      <div className="triage-keys">
        {folders.map((c, i) => (
          <button key={c.id} className="btn btn-sm" disabled={!cur} onClick={() => dispatch({ type: 'keep', folderId: c.id })}>
            <kbd>{i + 1}</kbd> {c.name}
          </button>
        ))}
        <button className="btn btn-sm" disabled={!cur} onClick={() => dispatch({ type: 'later' })}>
          <kbd>L</kbd> 稍后
        </button>
        <button className="btn btn-sm" disabled={!cur} onClick={() => dispatch({ type: 'archive' })}>
          <kbd>A</kbd> 归档
        </button>
        <button className="btn btn-sm" disabled={!cur} onClick={() => dispatch({ type: 'discard' })}>
          <kbd>D</kbd> 丢弃
        </button>
        <button className="btn btn-sm" disabled={!cur} onClick={() => dispatch({ type: 'skip' })}>
          <kbd>S</kbd> 跳过
        </button>
      </div>
    </Modal>
  )
}
