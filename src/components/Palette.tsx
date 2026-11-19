import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  run: () => void
}

/** Ctrl/⌘+K command palette. */
export default function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const list = useMemo(() => commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())), [commands, q])
  const pick = (c?: Command) => {
    if (!c) return
    onClose()
    c.run()
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="命令面板" onClick={(e) => e.stopPropagation()}>
        <input
          ref={ref}
          value={q}
          placeholder="输入命令…"
          onChange={(e) => {
            setQ(e.target.value)
            setI(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setI((x) => Math.min(list.length - 1, x + 1))
            else if (e.key === 'ArrowUp') setI((x) => Math.max(0, x - 1))
            else if (e.key === 'Enter') pick(list[i])
          }}
        />
        <ul>
          {list.map((c, k) => (
            <li key={c.id} className={k === i ? 'active' : ''} onMouseEnter={() => setI(k)} onClick={() => pick(c)}>
              {c.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
