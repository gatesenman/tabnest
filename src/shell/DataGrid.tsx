import { canPreview, previewSrc } from '../../shared/preview'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Globe } from 'lucide-react'
import type { TabItem } from '../../shared/types'
import { type Lifecycle } from '../../shared/lifecycle'

export interface GridRow extends TabItem {
  firstSeen: string
  lastSeen: string
  seenCount: number
  sourceLabel: string
  folderLabel: string
  life?: Lifecycle
  deletedAt?: string
}

type ColKey = 'icon' | 'thumb' | 'title' | 'url' | 'domain' | 'source' | 'firstSeen' | 'lastSeen' | 'life' | 'status' | 'folder'

interface Col {
  key: ColKey
  label: string
  width: number
  min: number
  sort?: (r: GridRow) => string | number
  render: (r: GridRow) => React.ReactNode
  align?: 'right'
}

const STATUS: Record<string, [string, string]> = {
  unchecked: ['—', 'st-none'],
  ok: ['正常', 'st-ok'],
  redirect: ['重定向', 'st-warn'],
  broken: ['失效', 'st-bad'],
  timeout: ['超时', 'st-warn'],
  checking: ['检查中…', 'st-none']
}

const fmt = (iso: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`
  return d.toDateString() === today.toDateString() ? `今天 ${t}` : `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${t}`
}

function Favicon({ r }: { r: GridRow }) {
  const [bad, setBad] = useState(false)
  if (!r.favicon || bad) return <Globe size={14} className="fav-fallback" />
  return <img className="fav" src={r.favicon} alt="" onError={() => setBad(true)} />
}

/** Lazy thumbnail from the preview cache (only visible rows are rendered by the virtualizer). Misses are remembered for 2 min. */
const thumbMiss = new Map<string, number>()
/** bumped whenever the grid's rows change (data:changed after captures) so missing thumbnails are retried */
let thumbEpoch = 0
function Thumb({ r }: { r: GridRow }) {
  const [bad, setBad] = useState(() => (thumbMiss.get(r.url) ?? 0) > Date.now() - 120000)
  if (bad || !canPreview(r.url)) return <span className="thumb thumb-empty" aria-hidden />
  return (
    <img
      className="thumb"
      src={previewSrc(r.url)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => {
        thumbMiss.set(r.url, Date.now())
        setBad(true)
      }}
    />
  )
}

const COLS: Col[] = [
  { key: 'icon', label: '', width: 28, min: 28, render: (r) => <Favicon r={r} /> },
  { key: 'thumb', label: '预览', width: 64, min: 40, render: (r) => <Thumb key={`${r.url}:${thumbEpoch}`} r={r} /> },
  { key: 'title', label: '标题', width: 300, min: 80, sort: (r) => r.title.toLowerCase(), render: (r) => <span title={r.title}>{r.title}</span> },
  { key: 'url', label: '网址', width: 220, min: 80, sort: (r) => r.url, render: (r) => <span className="dim">{r.url}</span> },
  { key: 'domain', label: '域名', width: 140, min: 60, sort: (r) => r.domain, render: (r) => r.domain },
  { key: 'source', label: '来源浏览器', width: 120, min: 60, sort: (r) => r.sourceLabel, render: (r) => r.sourceLabel },
  { key: 'firstSeen', label: '首次出现', width: 128, min: 70, sort: (r) => r.firstSeen, render: (r) => fmt(r.firstSeen) },
  { key: 'lastSeen', label: '最后出现', width: 128, min: 70, sort: (r) => r.lastSeen, render: (r) => fmt(r.lastSeen) },
  {
    key: 'status',
    label: '链接',
    width: 64,
    min: 50,
    sort: (r) => r.linkStatus,
    render: (r) => {
      const [t, c] = STATUS[r.linkStatus] ?? STATUS.unchecked
      return (
        <span className={c} title={r.linkStatusNote ?? ''}>
          {t}
        </span>
      )
    }
  },
  { key: 'folder', label: '收藏夹', width: 110, min: 60, sort: (r) => r.folderLabel, render: (r) => r.folderLabel }
]

const LS = 'tabnest.grid.widths'

export interface Selection {
  ids: Set<string>
  anchor: string | null
  focus: string | null
}

export function DataGrid({
  rows,
  rowHeight,
  sel,
  setSel,
  onOpen,
  onDelete,
  onContext,
  empty
}: {
  rows: GridRow[]
  rowHeight: number
  sel: Selection
  setSel: (s: Selection) => void
  onOpen: (ids: string[]) => void
  onDelete: (ids: string[]) => void
  onContext: (x: number, y: number) => void
  empty?: React.ReactNode
}) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS) ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  })
  useEffect(() => localStorage.setItem(LS, JSON.stringify(widths)), [widths])
  const [sort, setSort] = useState<{ key: ColKey; dir: 1 | -1 }>({ key: 'lastSeen', dir: -1 })
  useMemo(() => {
    thumbMiss.clear()
    thumbEpoch++
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-run when the row set changes
  }, [rows])
  const cols = COLS.map((c) => ({ ...c, width: widths[c.key] ?? c.width }))
  const total = cols.reduce((n, c) => n + c.width, 0)

  const sorted = useMemo(() => {
    const c = COLS.find((x) => x.key === sort.key)
    if (!c?.sort) return rows
    const get = c.sort
    return [...rows].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [rows, sort])

  const scrollRef = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: sorted.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 12 })
  useEffect(() => v.measure(), [rowHeight, v])

  const indexOf = (id: string | null) => (id ? sorted.findIndex((r) => r.id === id) : -1)

  const click = (e: React.MouseEvent, r: GridRow) => {
    if (e.shiftKey && sel.anchor) {
      const a = indexOf(sel.anchor)
      const b = indexOf(r.id)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const ids = new Set(e.ctrlKey || e.metaKey ? sel.ids : [])
      for (let i = lo; i <= hi; i++) ids.add(sorted[i].id)
      setSel({ ids, anchor: sel.anchor, focus: r.id })
    } else if (e.ctrlKey || e.metaKey) {
      const ids = new Set(sel.ids)
      if (ids.has(r.id)) ids.delete(r.id)
      else ids.add(r.id)
      setSel({ ids, anchor: r.id, focus: r.id })
    } else setSel({ ids: new Set([r.id]), anchor: r.id, focus: r.id })
  }

  const onKey = (e: React.KeyboardEvent) => {
    const i = indexOf(sel.focus)
    const go = (j: number) => {
      j = Math.max(0, Math.min(sorted.length - 1, j))
      const r = sorted[j]
      if (!r) return
      if (e.shiftKey && sel.anchor) {
        const a = indexOf(sel.anchor)
        const [lo, hi] = a < j ? [a, j] : [j, a]
        setSel({ ids: new Set(sorted.slice(lo, hi + 1).map((x) => x.id)), anchor: sel.anchor, focus: r.id })
      } else setSel({ ids: new Set([r.id]), anchor: r.id, focus: r.id })
      v.scrollToIndex(j)
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight) - 1)
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1)
    else if (e.key === 'PageDown') go(i + page)
    else if (e.key === 'PageUp') go(i - page)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(sorted.length - 1)
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')
      setSel({ ids: new Set(sorted.map((r) => r.id)), anchor: sorted[0]?.id ?? null, focus: sel.focus })
    else if (e.key === 'Enter' && sel.ids.size) onOpen([...sel.ids])
    else if (e.key === 'Delete' && sel.ids.size) onDelete([...sel.ids])
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const r = scrollRef.current?.getBoundingClientRect()
      onContext((r?.left ?? 0) + 40, (r?.top ?? 0) + 40)
    } else if (e.key === 'Escape') setSel({ ids: new Set(), anchor: null, focus: null })
    else return
    e.preventDefault()
  }

  const startResize = (e: React.MouseEvent, key: ColKey, min: number) => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = cols.find((c) => c.key === key)!.width
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [key]: Math.max(min, w0 + ev.clientX - x0) }))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="grid" ref={scrollRef} tabIndex={0} role="grid" aria-rowcount={sorted.length} aria-multiselectable onKeyDown={onKey}>
      <div className="grid-head" role="row" style={{ width: total }}>
        {cols.map((c) => (
          <div
            key={c.key}
            role="columnheader"
            className={`gh ${c.sort ? 'sortable' : ''}`}
            style={{ width: c.width }}
            aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
            onClick={() => c.sort && setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : 1 }))}
          >
            <span>{c.label}</span>
            {sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
            <span
              className="gh-resize"
              onMouseDown={(e) => startResize(e, c.key, c.min)}
              onDoubleClick={() => setWidths((w) => ({ ...w, [c.key]: COLS.find((x) => x.key === c.key)!.width }))}
            />
          </div>
        ))}
      </div>
      {sorted.length === 0 && empty ? (
        <div className="grid-empty">{empty}</div>
      ) : (
        <div style={{ height: v.getTotalSize(), width: total, position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const r = sorted[vi.index]
            const s = sel.ids.has(r.id)
            return (
              <div
                key={r.id}
                role="row"
                aria-selected={s}
                data-row-id={r.id}
                className={`gr ${s ? 'sel' : ''} ${sel.focus === r.id ? 'focus' : ''} ${vi.index % 2 ? 'alt' : ''}`}
                style={{ transform: `translateY(${vi.start}px)`, height: rowHeight, width: total }}
                onMouseDown={(e) => {
                  if (e.button === 2 && sel.ids.has(r.id)) return
                  click(e, r)
                }}
                onDoubleClick={() => onOpen([r.id])}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (!sel.ids.has(r.id)) setSel({ ids: new Set([r.id]), anchor: r.id, focus: r.id })
                  onContext(e.clientX, e.clientY)
                }}
              >
                {cols.map((c) => (
                  <div key={c.key} role="gridcell" className={`gc gc-${c.key}`} style={{ width: c.width }}>
                    {c.render(r)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
