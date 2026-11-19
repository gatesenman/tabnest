import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { parseTabLines } from '../../shared/url'
import type { Collection } from '../../shared/types'

/** Windows-style modal dialog: title strip, body, right-aligned footer buttons. */
export function Modal({
  children,
  onClose,
  title,
  footer,
  width
}: {
  children: React.ReactNode
  onClose: () => void
  title?: string
  footer?: React.ReactNode
  width?: number
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="dlg" role="dialog" aria-label={title} style={width ? { width } : undefined} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-title">
          <span>{title ?? 'TabNest'}</span>
          <button className="dlg-x" aria-label="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="dlg-body">{children}</div>
        {footer && <div className="dlg-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function PromptModal({
  title,
  initial,
  placeholder,
  onDone
}: {
  title: string
  initial: string
  placeholder?: string
  onDone: (v: string | null) => void
}) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  return (
    <Modal
      title={title}
      onClose={() => onDone(null)}
      width={380}
      footer={
        <>
          <button className="btn btn-primary" onClick={() => onDone(v.trim())}>
            确定
          </button>
          <button className="btn" onClick={() => onDone(null)}>
            取消
          </button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), onDone(v.trim()))}>
        <input ref={ref} className="field-input" autoFocus value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
      </form>
    </Modal>
  )
}

export function FolderPicker({
  collections,
  count,
  onPick,
  onNew,
  onClose
}: {
  collections: Collection[]
  count: number
  onPick: (id: string) => void
  onNew: () => void
  onClose: () => void
}) {
  const [sel, setSel] = useState<string | null>(collections[0]?.id ?? null)
  return (
    <Modal
      title="移入收藏夹"
      onClose={onClose}
      width={400}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} onClick={onNew}>
            新建收藏夹…
          </button>
          <button className="btn btn-primary" disabled={!sel} onClick={() => sel && onPick(sel)}>
            确定
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <p className="muted">将 {count} 项移入：</p>
      <div className="listbox" role="listbox">
        {collections.map((c, i) => (
          <div
            key={c.id}
            role="option"
            aria-selected={sel === c.id}
            className={`listbox-item ${sel === c.id ? 'sel' : ''}`}
            onClick={() => setSel(c.id)}
            onDoubleClick={() => onPick(c.id)}
          >
            {i < 9 && <kbd>{i + 1}</kbd>} {c.name}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function CaptureModal({
  initialText,
  onClose,
  onCreate
}: {
  initialText: string
  onClose: () => void
  onCreate: (name: string, note: string, tabs: { title: string; url: string }[]) => void
}) {
  const [text, setText] = useState(initialText)
  const parsed = parseTabLines(text)
  return (
    <Modal
      title="粘贴链接到今日快照"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto' }}>
            已识别 {parsed.length} 个
          </span>
          <button className="btn btn-primary" disabled={!parsed.length} onClick={() => onCreate('粘贴', '', parsed)}>
            确定
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <p className="muted">每行一个网址，或「标题⇥网址」、Markdown 链接、JSON 数组。会并入今日快照并自动去重。</p>
      <textarea
        className="field-input"
        rows={12}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'https://example.com\n标题\thttps://example.com/page'}
      />
    </Modal>
  )
}
