import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

export interface TreeNode {
  id: string
  label: string
  icon?: React.ReactNode
  count?: number
  /** small warning marker (e.g. stale browser data) */
  warn?: string
  badge?: number
  children?: TreeNode[]
}

const LS = 'tabnest.tree.expanded'

/** Explorer-style tree: click/arrow keys select, ←/→ collapse/expand, F2 rename, context menu per node. */
export function NavTree({
  nodes,
  selected,
  onSelect,
  onContext,
  onRename,
  defaultExpanded
}: {
  nodes: TreeNode[]
  selected: string
  onSelect: (id: string) => void
  onContext?: (id: string, x: number, y: number) => void
  onRename?: (id: string) => void
  defaultExpanded: string[]
}) {
  const [exp, setExp] = useState<Set<string>>(() => {
    try {
      const v = localStorage.getItem(LS)
      if (v) return new Set(JSON.parse(v) as string[])
    } catch {
      /* ignore */
    }
    return new Set(defaultExpanded)
  })
  useEffect(() => localStorage.setItem(LS, JSON.stringify([...exp])), [exp])
  const ref = useRef<HTMLDivElement>(null)

  const flat = useMemo(() => {
    const out: { n: TreeNode; depth: number; parent: string | null }[] = []
    const walk = (list: TreeNode[], depth: number, parent: string | null) => {
      for (const n of list) {
        out.push({ n, depth, parent })
        if (n.children?.length && exp.has(n.id)) walk(n.children, depth + 1, n.id)
      }
    }
    walk(nodes, 0, null)
    return out
  }, [nodes, exp])

  const toggle = (id: string, on?: boolean) =>
    setExp((p) => {
      const s = new Set(p)
      if (on ?? !s.has(id)) s.add(id)
      else s.delete(id)
      return s
    })

  const onKey = (e: React.KeyboardEvent) => {
    const i = flat.findIndex((f) => f.n.id === selected)
    const cur = flat[i]
    if (e.key === 'ArrowDown' && i < flat.length - 1) onSelect(flat[i + 1].n.id)
    else if (e.key === 'ArrowUp' && i > 0) onSelect(flat[i - 1].n.id)
    else if (e.key === 'ArrowRight' && cur?.n.children?.length) {
      if (!exp.has(cur.n.id)) toggle(cur.n.id, true)
      else onSelect(cur.n.children[0].id)
    } else if (e.key === 'ArrowLeft' && cur) {
      if (cur.n.children?.length && exp.has(cur.n.id)) toggle(cur.n.id, false)
      else if (cur.parent) onSelect(cur.parent)
    } else if (e.key === 'F2' && onRename) onRename(selected)
    else return
    e.preventDefault()
  }

  return (
    <div ref={ref} className="tree" role="tree" tabIndex={0} onKeyDown={onKey} aria-label="导航">
      {flat.map(({ n, depth }) => {
        const hasKids = !!n.children?.length
        return (
          <div
            key={n.id}
            role="treeitem"
            aria-selected={selected === n.id}
            aria-expanded={hasKids ? exp.has(n.id) : undefined}
            data-node={n.id}
            className={`tree-row ${selected === n.id ? 'sel' : ''}`}
            style={{ paddingLeft: 4 + depth * 16 }}
            onClick={() => {
              onSelect(n.id)
              ref.current?.focus()
            }}
            onDoubleClick={() => hasKids && toggle(n.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              onSelect(n.id)
              onContext?.(n.id, e.clientX, e.clientY)
            }}
          >
            <span
              className="tree-twisty"
              onClick={(e) => {
                e.stopPropagation()
                if (hasKids) toggle(n.id)
              }}
            >
              {hasKids ? exp.has(n.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
            </span>
            <span className="tree-icon">{n.icon}</span>
            <span className="tree-label">{n.label}</span>
            {n.warn && (
              <span className="tree-warn" title={n.warn}>
                !
              </span>
            )}
            {n.badge ? <span className="tree-badge">{n.badge}</span> : n.count !== undefined ? <span className="tree-count">{n.count}</span> : null}
          </div>
        )
      })}
    </div>
  )
}
