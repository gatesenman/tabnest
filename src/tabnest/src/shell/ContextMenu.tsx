import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'

export interface MenuItem {
  label?: string
  icon?: React.ReactNode
  accel?: string
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  submenu?: MenuItem[]
  action?: () => void
}

/** Popup menu list (shared by the menu bar and right-click menus). */
export function MenuList({ items, onDone, style }: { items: MenuItem[]; onDone: () => void; style?: React.CSSProperties }) {
  const [open, setOpen] = useState<number | null>(null)
  const [hi, setHi] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(style)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !style) return
    const r = el.getBoundingClientRect()
    const next = { ...style }
    if (r.right > window.innerWidth) next.left = Math.max(0, window.innerWidth - r.width - 4)
    if (r.bottom > window.innerHeight) next.top = Math.max(0, window.innerHeight - r.height - 4)
    setPos(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const usable = items.map((x, i) => (!x.separator && !x.disabled ? i : -1)).filter((i) => i >= 0)
      if (e.key === 'ArrowDown') setHi((h) => usable[(usable.indexOf(h) + 1) % usable.length] ?? -1)
      else if (e.key === 'ArrowUp') setHi((h) => usable[(usable.indexOf(h) - 1 + usable.length) % usable.length] ?? -1)
      else if (e.key === 'Enter' && hi >= 0) {
        const it = items[hi]
        if (it.submenu) setOpen(hi)
        else {
          onDone()
          it.action?.()
        }
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [items, hi, onDone])
  return (
    <div ref={ref} className="menu" role="menu" style={pos} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <div
            key={i}
            role="menuitem"
            aria-disabled={it.disabled}
            className={`menu-item ${it.disabled ? 'disabled' : ''} ${hi === i ? 'hi' : ''}`}
            onMouseEnter={() => {
              setHi(i)
              setOpen(it.submenu ? i : null)
            }}
            onClick={() => {
              if (it.disabled || it.submenu) return
              onDone()
              it.action?.()
            }}
          >
            <span className="menu-icon">{it.checked ? '✓' : it.icon}</span>
            <span className="menu-label">{it.label}</span>
            <span className="menu-accel">{it.accel}</span>
            {it.submenu && <ChevronRight size={12} />}
            {it.submenu && open === i && (
              <div className="submenu-anchor">
                <MenuList items={it.submenu} onDone={onDone} />
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])
  return <MenuList items={items} onDone={onClose} style={{ position: 'fixed', left: x, top: y }} />
}
