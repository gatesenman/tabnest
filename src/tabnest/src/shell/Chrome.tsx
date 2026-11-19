import { useEffect, useRef, useState } from 'react'
import { Camera, CheckCircle2, ExternalLink, FolderInput, Minus, Power, Search, Sparkles, Square, Copy as Restore, Trash2, X } from 'lucide-react'
import { call, onEvent } from '../api'
import { MenuList, type MenuItem } from './ContextMenu'

export function TitleBar({ title }: { title: string }) {
  const [st, setSt] = useState<{ maximized: boolean; frameless: boolean; platform: string }>({
    maximized: false,
    frameless: true,
    platform: window.tabnest?.platform ?? 'win32'
  })
  useEffect(() => onEvent('window:state', setSt), [])
  if (!st.frameless) return null
  const mac = st.platform === 'darwin'
  return (
    <div className="titlebar" onDoubleClick={() => void call('window:control', { action: 'maximize' })}>
      {!mac && <img className="titlebar-icon" src="./icon.png" alt="" />}
      <span className="titlebar-title" style={mac ? { marginLeft: 76 } : undefined}>
        {title}
      </span>
      <div className="titlebar-drag" />
      {!mac && (
        <div className="wc">
          <button aria-label="最小化" onClick={() => void call('window:control', { action: 'minimize' })}>
            <Minus size={14} />
          </button>
          <button aria-label={st.maximized ? '还原' : '最大化'} onClick={() => void call('window:control', { action: 'maximize' })}>
            {st.maximized ? <Restore size={12} /> : <Square size={12} />}
          </button>
          <button className="wc-close" aria-label="关闭" onClick={() => void call('window:control', { action: 'close' })}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

export interface TopMenu {
  label: string
  /** access key shown underlined, e.g. 'F' for 文件(F) */
  key: string
  items: MenuItem[]
}

/** Classic menu bar. Alt toggles access-key mode; Alt+<key> opens a menu; ←/→ move between menus. */
export function MenuBar({ menus }: { menus: TopMenu[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const [alt, setAlt] = useState(false)
  const altOnly = useRef(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altOnly.current = true
        return
      }
      altOnly.current = false
      if (e.altKey && !e.ctrlKey) {
        const i = menus.findIndex((m) => m.key.toLowerCase() === e.key.toLowerCase())
        if (i >= 0) {
          e.preventDefault()
          setOpen(i)
          setAlt(true)
        }
      } else if (open !== null) {
        if (e.key === 'ArrowRight') setOpen((open + 1) % menus.length)
        else if (e.key === 'ArrowLeft') setOpen((open - 1 + menus.length) % menus.length)
        else if (e.key === 'Escape') setOpen(null)
        else if (alt && !e.ctrlKey && /^[a-z]$/i.test(e.key)) {
          const i = menus.findIndex((m) => m.key.toLowerCase() === e.key.toLowerCase())
          if (i >= 0) setOpen(i)
        }
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altOnly.current) {
        e.preventDefault()
        setAlt((a) => !a)
      }
    }
    const close = () => {
      setOpen(null)
      setAlt(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('mousedown', close)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('mousedown', close)
    }
  }, [menus, open, alt])
  return (
    <div className={`menubar ${alt ? 'show-keys' : ''}`} role="menubar">
      {menus.map((m, i) => (
        <div key={m.label} className="menubar-wrap">
          <button
            role="menuitem"
            className={`menubar-item ${open === i ? 'open' : ''}`}
            onMouseDown={(e) => {
              e.stopPropagation()
              setOpen(open === i ? null : i)
            }}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}(<u>{m.key}</u>)
          </button>
          {open === i && (
            <MenuList
              items={m.items}
              onDone={() => {
                setOpen(null)
                setAlt(false)
              }}
              style={{ position: 'absolute', left: 0, top: '100%' }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

export interface ToolbarProps {
  hasSel: boolean
  inTrash: boolean
  query: string
  setQuery: (q: string) => void
  aiSearch?: boolean
  setAiSearch?: (v: boolean) => void
  /** Enter in 智能搜索 mode: cloud rewrite + AI 问答 */
  onSearchEnter?: () => void
  searchRef: React.RefObject<HTMLInputElement>
  onSnapshot: () => void
  onCloseAll: () => void
  onOpen: () => void
  onMove: () => void
  onCheck: () => void
  onSummarize: () => void
  summarizing?: boolean
  onDelete: () => void
}

function TB({
  icon,
  label,
  onClick,
  disabled,
  danger,
  title
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button className={`tb ${danger ? 'tb-accent' : ''}`} disabled={disabled} onClick={onClick} title={title ?? label}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function Toolbar(p: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar">
      <TB icon={<Camera size={16} />} label="立即快照" title="立即快照 (F5)" onClick={p.onSnapshot} />
      <TB icon={<Power size={16} />} label="快照并关闭" title="快照并关闭所有浏览器" danger onClick={p.onCloseAll} />
      <div className="tb-sep" />
      <TB icon={<ExternalLink size={16} />} label="打开" title="打开 (Enter)" disabled={!p.hasSel} onClick={p.onOpen} />
      <TB icon={<FolderInput size={16} />} label="移入收藏夹" disabled={!p.hasSel || p.inTrash} onClick={p.onMove} />
      <div className="tb-sep" />
      <TB icon={<CheckCircle2 size={16} />} label="检查链接" disabled={!p.hasSel || p.inTrash} onClick={p.onCheck} />
      <TB
        icon={<Sparkles size={16} className={p.summarizing ? 'spin' : undefined} />}
        label={p.summarizing ? '生成中…' : 'AI 摘要'}
        disabled={!p.hasSel || p.inTrash || p.summarizing}
        onClick={p.onSummarize}
      />
      <div className="tb-sep" />
      <TB icon={<Trash2 size={16} />} label={p.inTrash ? '彻底删除' : '删除'} title="删除 (Delete)" disabled={!p.hasSel} onClick={p.onDelete} />
      <div className="tb-spacer" />
      <label className="tb-search">
        <Search size={14} />
        <input
          ref={p.searchRef}
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && p.aiSearch && p.onSearchEnter?.()}
          placeholder={p.aiSearch ? '智能搜索：如“上周在 Edge 看的 React 文档”，问题按 Enter 让 AI 回答' : '搜索 (Ctrl+F)'}
          aria-label="搜索"
        />
        {p.setAiSearch && (
          <button
            className={`tb-ai ${p.aiSearch ? 'on' : ''}`}
            data-testid="ai-search-toggle"
            aria-pressed={!!p.aiSearch}
            title="智能搜索：识别时间 / 浏览器 / 站点 / 收藏夹 / 状态，按关键词 + 语义相似度排序；启用云端 AI 后按 Enter 可直接提问"
            onClick={(e) => {
              e.preventDefault()
              p.setAiSearch!(!p.aiSearch)
            }}
          >
            AI
          </button>
        )}
        {p.query && (
          <button aria-label="清除" onClick={() => p.setQuery('')}>
            <X size={12} />
          </button>
        )}
      </label>
    </div>
  )
}

export function StatusBar({
  total,
  selected,
  today,
  auto,
  job,
  onCancelJob
}: {
  total: number
  selected: number
  today: number
  auto?: string
  job: { done: number; total: number } | null
  onCancelJob: () => void
}) {
  return (
    <div className="statusbar" role="status">
      <span>共 {total.toLocaleString()} 项</span>
      <span className="sb-sep" />
      <span>已选 {selected}</span>
      <span className="sb-sep" />
      <span>今日快照 {today} 个标签</span>
      {auto && (
        <>
          <span className="sb-sep" />
          <span className={auto.includes('关闭') || auto.includes('首次') ? 'sb-dim' : 'sb-ok'} data-testid="auto-indicator">
            ⟳ {auto}
          </span>
        </>
      )}
      <span className="sb-fill" />
      {job && (
        <span className="sb-job">
          检查链接 {job.done}/{job.total}
          <span className="sb-bar">
            <span style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} />
          </span>
          <button className="link" onClick={onCancelJob}>
            取消
          </button>
        </span>
      )}
    </div>
  )
}
