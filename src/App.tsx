import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Calendar,
  CalendarDays,
  Chrome,
  Copy,
  Files,
  Folder,
  FolderOpen,
  Globe,
  Inbox,
  LayoutDashboard,
  Monitor,
  Trash2,
  ExternalLink,
  FolderInput,
  CheckCircle2,
  Sparkles,
  RotateCcw,
  Power,
  Camera,
  Settings as Gear,
  Scale,
  History,
  Bot
} from 'lucide-react'
import type { Collection, LinkCheckProgress, Snapshot, TabItem } from '../shared/types'
import { call, onEvent, type BrowserCardUI } from './api'
import { Ctx, type AppCtx } from './ctx'
import { CaptureModal, FolderPicker, Modal, PromptModal } from './components/Modals'
import CloseBrowsersModal from './components/CloseBrowsers'
import Palette from './components/Palette'
import DedupView from './views/DedupView'
import { MenuBar, StatusBar, TitleBar, Toolbar, type TopMenu } from './shell/Chrome'
import { NavTree, type TreeNode } from './shell/NavTree'
import { DataGrid, type GridRow, type Selection } from './shell/DataGrid'
import { DetailsPane, localDay } from './shell/Panes'
import { ContextMenu, type MenuItem } from './shell/ContextMenu'
import { SettingsDialog, type SettingsTab } from './shell/SettingsDialog'
import { TriageDialog } from './shell/TriageDialog'
import { AutoOrgPane } from './shell/AutoOrg'
import { SmartBar, type AskAnswer, type SmartMeta } from './shell/SmartBar'
import { OverviewHome, ReconcilePane, WelcomeDialog } from './shell/Insights'
import { buildLifecycle } from '../shared/lifecycle'
import type { Reconciliation, FixAction } from '../shared/reconcile'
import type { Outputs } from './api'

const BROWSER_NAMES: Record<string, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  chromium: 'Chromium',
  firefox: 'Firefox',
  qqbrowser: 'QQ浏览器',
  '360se': '360安全',
  '360chrome': '360极速',
  sogou: '搜狗',
  '2345': '2345',
  liebao: '猎豹',
  quark: '夸克',
  lenovo: '联想',
  paste: '粘贴',
  extension: '扩展'
}
const bname = (id: string | null) => (id ? (BROWSER_NAMES[id] ?? id) : '')
const EMPTY_SEL: Selection = { ids: new Set(), anchor: null, focus: null }
const sz = 14

function useLocal<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s ? (JSON.parse(s) as T) : init
    } catch {
      return init
    }
  })
  const set = useCallback(
    (x: T) => {
      setV(x)
      localStorage.setItem(key, JSON.stringify(x))
    },
    [key]
  )
  return [v, set]
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [node, setNode] = useState('overview')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Set<string> | null>(null)
  const [aiSearch, setAiSearch] = useState(false)
  /** 智能搜索 metadata: parsed chips, rank order, latency; and the AI 问答 answer (cloud only) */
  const [smart, setSmart] = useState<SmartMeta | null>(null)
  const [answer, setAnswer] = useState<AskAnswer | null>(null)
  const [sel, setSel] = useState<Selection>(EMPTY_SEL)
  const [browsers, setBrowsers] = useState<BrowserCardUI[]>([])
  const [job, setJob] = useState<LinkCheckProgress | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dialog, setDialog] = useState<
    | null
    | { kind: 'settings'; tab?: SettingsTab }
    | { kind: 'close' }
    | { kind: 'paste' }
    | { kind: 'palette' }
    | { kind: 'triage' }
    | { kind: 'picker'; ids: string[] }
    | { kind: 'prompt'; title: string; initial: string; resolve: (v: string | null) => void }
    | { kind: 'about' }
    | { kind: 'keys' }
  >(null)
  const [density, setDensity] = useState<'compact' | 'comfortable'>('compact')
  const [recon, setRecon] = useState<Reconciliation[] | null>(null)
  const [reconLoading, setReconLoading] = useState(false)
  const [appStatus, setAppStatus] = useState<{
    updateConfigured: boolean
    autoSnapshotMinutes: number
    lastCaptureAt: string | null
    nextAutoAt: string | null
  } | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [view] = useState<{ ids: string[]; title: string } | null>(null)
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  const [live, setLive] = useState<{ node: string; tabs: Outputs['browsers:liveTabs'] } | null>(null)
  const applyLook = useCallback((s: { density: 'compact' | 'comfortable'; theme: 'system' | 'light' | 'dark' }) => {
    setDensity(s.density)
    if (s.theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = s.theme
  }, [])
  const [showDetails, setShowDetails] = useLocal('tabnest.details', true)
  const [leftW, setLeftW] = useLocal('tabnest.leftW', 240)
  const [rightW, setRightW] = useLocal('tabnest.rightW', 300)
  const searchRef = useRef<HTMLInputElement>(null)
  const gridWrap = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const toast = useCallback((m: string) => {
    setToastMsg(m)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 3500)
  }, [])
  const refresh = useCallback(
    () =>
      call('data:snapshot')
        .then(setSnap)
        .catch((e: Error) => setError(e.message)),
    []
  )
  const scan = useCallback(
    () =>
      void call('browsers:scan', { force: false })
        .then(setBrowsers)
        .catch(() => undefined),
    []
  )
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string)) => {
      try {
        const r = await fn()
        if (ok) toast(typeof ok === 'string' ? ok : ok(r))
        return r
      } catch (e) {
        toast(`出错了：${e instanceof Error ? e.message : String(e)}`)
        return undefined
      }
    },
    [toast]
  )
  const ask = useCallback((title: string, initial = '') => new Promise<string | null>((resolve) => setDialog({ kind: 'prompt', title, initial, resolve })), [])

  useEffect(() => {
    void refresh()
    scan()
    void call('settings:get').then(applyLook)
    const tick = () => {
      void call('app:status')
        .then(setAppStatus)
        .catch(() => undefined)
    }
    void loadRecon()
    tick()
    const iv = setInterval(tick, 10000)
    const onSettings = (e: Event) => applyLook((e as CustomEvent).detail)
    window.addEventListener('tabnest:settings', onSettings)
    let pending: ReturnType<typeof setTimeout> | undefined
    const offs = [
      onEvent('data:changed', () => {
        clearTimeout(pending)
        pending = setTimeout(() => {
          void refresh()
          void call('settings:get').then(applyLook)
        }, 60)
      }),
      onEvent('linkcheck:progress', (p) => setJob(p.finished ? null : p)),
      onEvent('ui:toast', toast),
      onEvent('capture:done', () => scan()),
      onEvent('ui:quickCapture', () => setDialog({ kind: 'paste' })),
      onEvent('ui:navigate', (v) => {
        if (v === 'close-browsers') setDialog({ kind: 'close' })
        else if (v === 'import') void importHtml()
        else if (v === 'settings') setDialog({ kind: 'settings' })
        else if (v === 'search') searchRef.current?.focus()
        else if (v === 'export-json')
          void run(
            () => call('backup:exportJson'),
            (f) => (f ? `已导出 ${f}` : '已取消')
          )
        else if (v === 'export-html')
          void run(
            () => call('backup:exportHtml'),
            (f) => (f ? `已导出 ${f}` : '已取消')
          )
        else if (v === 'import-json')
          void run(
            () => call('backup:importJson'),
            (n) => (n === null ? '已取消' : `已恢复 ${n} 个标签`)
          )
        else
          setNode(
            { sessions: 'daily', unsorted: 'unsorted', collections: 'collections', dedup: 'dedup', home: 'overview', inbox: 'unsorted', timeline: 'daily' }[
              v
            ] ?? 'overview'
          )
      })
    ]
    return () => {
      window.removeEventListener('tabnest:settings', onSettings)
      clearInterval(iv)
      offs.forEach((o) => o())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Full-text search (FTS5 in main) → set of tab ids; 智能搜索 → parsed filters + hybrid ranking (ordered)
  useEffect(() => {
    setAnswer(null)
    if (!query.trim()) {
      setSmart(null)
      return setHits(null)
    }
    const t = setTimeout(
      () =>
        void (aiSearch
          ? call('search:smart', { q: query, limit: 500, cloud: false }).then((r) => {
              setHits(new Set(r.items.map((x) => x.id)))
              setSmart({ chips: r.chips, ms: r.ms, question: r.question, rank: new Map(r.items.map((x, i) => [x.id, i])), terms: r.terms })
            })
          : call('search:query', { q: query, limit: 5000 }).then((ids) => {
              setSmart(null)
              setHits(new Set(ids))
            })),
      150
    )
    return () => clearTimeout(t)
  }, [query, snap, aiSearch])

  /** Enter in AI mode: cloud query rewrite / embeddings + AI 问答 for questions (falls back to local results offline). */
  const askAi = useCallback(async () => {
    if (!aiSearch || !query.trim()) return
    setAnswer({ loading: true, answer: null, cites: [], source: 'local' })
    try {
      const r = await call('ai:ask', { q: query })
      setHits(new Set(r.search.items.map((x) => x.id)))
      setSmart({
        chips: r.search.chips,
        ms: r.search.ms,
        question: r.search.question,
        rank: new Map(r.search.items.map((x, i) => [x.id, i])),
        terms: r.search.terms
      })
      setAnswer({ loading: false, answer: r.answer, cites: r.cites, source: r.source, error: r.error })
    } catch (e) {
      setAnswer({ loading: false, answer: null, cites: [], source: 'local', error: e instanceof Error ? e.message : String(e) })
    }
  }, [aiSearch, query])

  useEffect(() => {
    setSel(EMPTY_SEL)
  }, [node])

  // Browser nodes show what the browser has open NOW (from capture), not only what is already in today's snapshot.
  useEffect(() => {
    if (!node.startsWith('browser:') && !node.startsWith('profile:')) return setLive(null)
    const [bid, pid] = node.replace(/^(profile|browser):/, '').split('::')
    let alive = true
    void call('browsers:liveTabs', { browserId: bid, profileId: pid ?? null })
      .then((tabs) => alive && setLive({ node, tabs }))
      .catch(() => alive && setLive({ node, tabs: [] }))
    return () => {
      alive = false
    }
  }, [node, snap])

  async function loadRecon() {
    setReconLoading(true)
    try {
      setRecon(await call('reconcile:get'))
    } catch {
      setRecon([])
    } finally {
      setReconLoading(false)
    }
  }

  const importHtml = async () => {
    const mode = confirm('导入书签 HTML：\n「确定」= 按书签文件夹放进收藏夹\n「取消」= 放进「未整理」') ? 'collections' : 'session'
    await run(
      () => call('bookmarks:import', { mode }),
      (r) => (r ? `已导入 ${r.count} 个书签` : '已取消')
    )
  }
  const snapshotNow = async () => {
    const r = await run(() => call('capture:now', {}))
    if (r) {
      toast(`今日快照：读取 ${r.total} 个，新增 ${r.newToday}，今日共 ${r.dayTotal}`)
      setNode(`day:${r.sessionId}`)
      scan()
    }
  }

  const ctx = useMemo<AppCtx | null>(() => {
    if (!snap) return null
    const moveTo = async (ids: string[], cid: string | null) => {
      const name = cid ? snap.collections.find((c) => c.id === cid)?.name : '未整理'
      await run(() => call('tabs:moveToCollection', { tabIds: ids, collectionId: cid }), `已将 ${ids.length} 项移入「${name}」`)
    }
    return {
      snap,
      run,
      toast,
      ask,
      moveTo,
      openUrls: (urls) => {
        const ok = urls.filter((u) => /^https?:/i.test(u))
        if (!ok.length) return
        if (ok.length > 30 && !confirm(`将在浏览器中打开 ${ok.length} 个标签页，确定吗？`)) return
        void run(() => call('open:urls', { urls: ok.slice(0, 500) }), `正在打开 ${ok.length} 个标签页`)
      },
      checkLinks: (ids) =>
        void run(
          () => call('links:check', { tabIds: ids }),
          (r) => `开始检查 ${r.total} 个链接`
        ),
      summarize: (ids) => {
        setSummarizing(true)
        void run(
          () => call('ai:summarize', { tabIds: ids }),
          (r) =>
            r.count ? `已重新生成 ${r.count} 项摘要 · ${r.reason}${r.missing ? `（${r.missing} 项未找到）` : ''}` : '没有可生成摘要的标签（可能已被删除）'
        ).finally(() => setSummarizing(false))
      },
      pickFolderAndMove: (ids) => setDialog({ kind: 'picker', ids }),
      collectionsById: new Map(snap.collections.map((c) => [c.id, c])),
      sessionsById: new Map(snap.sessions.map((s) => [s.id, s]))
    }
  }, [snap, run, toast, ask])

  // ---- derived data ----
  const agg = useMemo(() => {
    const m = new Map<string, { first: string; last: string; count: number; sources: Set<string> }>()
    for (const i of snap?.items ?? []) {
      const a = m.get(i.tabId)
      if (!a) m.set(i.tabId, { first: i.firstSeenAt, last: i.lastSeenAt, count: i.seenCount, sources: new Set(i.sources) })
      else {
        if (i.firstSeenAt < a.first) a.first = i.firstSeenAt
        if (i.lastSeenAt > a.last) a.last = i.lastSeenAt
        a.count += i.seenCount
        i.sources.forEach((s) => a.sources.add(s))
      }
    }
    return m
  }, [snap])

  const lc = useMemo(() => buildLifecycle(snap?.tabs ?? [], snap?.sessions ?? [], snap?.items ?? [], snap?.collections ?? []), [snap])

  const toRow = useCallback(
    (t: TabItem & { deletedAt?: string }, item?: { firstSeenAt: string; lastSeenAt: string; seenCount: number; sources: string[] }): GridRow => {
      const a = agg.get(t.id)
      const sources = item ? item.sources : a ? [...a.sources] : t.browserId ? [`${t.browserId}::`] : []
      const names = [...new Set(sources.map((s) => bname(s.split('::')[0])))].filter(Boolean)
      return {
        ...t,
        firstSeen: item?.firstSeenAt ?? a?.first ?? t.createdAt,
        lastSeen: item?.lastSeenAt ?? a?.last ?? t.lastActiveAt ?? t.createdAt,
        seenCount: item?.seenCount ?? a?.count ?? 1,
        sourceLabel: names.join('、') || (t.browserId ? bname(t.browserId) : '导入'),
        folderLabel: t.collectionId ? (ctx?.collectionsById.get(t.collectionId)?.name ?? '') : '未整理',
        life: t.deletedAt ? undefined : lc.status.get(t.id)
      }
    },
    [agg, ctx, lc]
  )

  const descendants = useCallback(
    (id: string): Set<string> => {
      const out = new Set([id])
      let grew = true
      while (grew) {
        grew = false
        for (const c of snap?.collections ?? [])
          if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
            out.add(c.id)
            grew = true
          }
      }
      return out
    },
    [snap]
  )

  const rows = useMemo<GridRow[]>(() => {
    if (!snap) return []
    let base: GridRow[]
    if (node === 'trash') base = snap.trash.map((t) => toRow(t))
    else if (hits) {
      base = snap.tabs.filter((t) => hits.has(t.id)).map((t) => toRow(t))
      const rank = smart?.rank
      if (rank) base.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
    } else if (node.startsWith('day:')) {
      const sid = node.slice(4)
      const byId = new Map(snap.tabs.map((t) => [t.id, t]))
      base = snap.items.filter((i) => i.sessionId === sid && byId.has(i.tabId)).map((i) => toRow(byId.get(i.tabId)!, i))
    } else if (node.startsWith('s:')) base = snap.tabs.filter((t) => t.sessionId === node.slice(2)).map((t) => toRow(t))
    else if (node.startsWith('col:')) {
      const ids = descendants(node.slice(4))
      base = snap.tabs.filter((t) => t.collectionId && ids.has(t.collectionId)).map((t) => toRow(t))
    } else if (node === 'collections') base = snap.tabs.filter((t) => t.collectionId).map((t) => toRow(t))
    else if (node === 'unsorted') base = snap.tabs.filter((t) => !t.collectionId).map((t) => toRow(t))
    else if ((node.startsWith('profile:') || node.startsWith('browser:')) && live?.node === node) {
      const bid = node.replace(/^(profile|browser):/, '').split('::')[0]
      const byNorm = new Map(snap.tabs.map((t) => [t.normUrl, t]))
      base = live.tabs.map((l) => {
        const t = byNorm.get(l.normUrl)
        if (t) return toRow(t)
        const synthetic: TabItem = {
          id: `live:${l.normUrl}`,
          sessionId: null,
          collectionId: null,
          title: l.title,
          url: l.url,
          normUrl: l.normUrl,
          domain: (() => {
            try {
              return new URL(l.url).hostname.replace(/^www\./, '')
            } catch {
              return ''
            }
          })(),
          favicon: '',
          createdAt: l.lastActiveAt ?? new Date().toISOString(),
          groupName: null,
          description: '',
          keywords: [],
          linkStatus: 'unknown',
          linkStatusCode: null,
          linkStatusNote: null,
          lastCheckedAt: null,
          browserId: bid,
          profileId: l.profileId,
          pinned: l.pinned,
          lastActiveAt: l.lastActiveAt,
          note: '',
          organizedAt: null
        }
        return { ...toRow(synthetic), sourceLabel: bname(bid), folderLabel: '未保存', life: 'new' as const }
      })
    } else if (node.startsWith('profile:') || node.startsWith('browser:')) {
      const [bid, pid] = node.replace(/^(profile|browser):/, '').split('::')
      const today = snap.sessions.find((s) => s.day === localDay())
      const items = today ? snap.items.filter((i) => i.sessionId === today.id) : []
      const byId = new Map(snap.tabs.map((t) => [t.id, t]))
      base = items
        .filter((i) => i.sources.some((s) => s.split('::')[0] === bid && (!pid || s.split('::')[1] === pid)) && byId.has(i.tabId))
        .map((i) => toRow(byId.get(i.tabId)!, i))
    } else if (node === 'daily') {
      const today = snap.sessions.find((s) => s.day === localDay())
      const byId = new Map(snap.tabs.map((t) => [t.id, t]))
      base = today ? snap.items.filter((i) => i.sessionId === today.id && byId.has(i.tabId)).map((i) => toRow(byId.get(i.tabId)!, i)) : []
    } else if (node.startsWith('m:') || node.startsWith('y:')) {
      const pre = node.slice(2)
      const sids = new Set(snap.sessions.filter((s) => s.day?.startsWith(pre)).map((s) => s.id))
      const ids = new Set(snap.items.filter((i) => sids.has(i.sessionId)).map((i) => i.tabId))
      base = snap.tabs.filter((t) => ids.has(t.id)).map((t) => toRow(t))
    } else if (node === 'gone') {
      const ids = new Set(lc.disappeared)
      base = snap.tabs.filter((t) => ids.has(t.id)).map((t) => toRow(t))
    } else if (node === 'view' && view) {
      const ids = new Set(view.ids)
      base = snap.tabs.filter((t) => ids.has(t.id)).map((t) => toRow(t))
    } else base = []
    return base
  }, [snap, node, hits, smart, toRow, descendants, lc, view, live])

  const showGrid = !(node === 'overview' || node === 'dedup' || node === 'reconcile' || node === 'autoorg') || !!hits
  const selIds = [...sel.ids].filter((id) => rows.some((r) => r.id === id))
  const focusRow = rows.find((r) => r.id === sel.focus && sel.ids.has(r.id)) ?? (selIds.length === 1 ? rows.find((r) => r.id === selIds[0]) : undefined)
  const inTrash = node === 'trash' && !hits
  const selRows = rows.filter((r) => sel.ids.has(r.id))
  const selectedCollection = node.startsWith('col:') ? snap?.collections.find((c) => c.id === node.slice(4)) : undefined

  // ---- actions on selection ----
  /** Live (unsaved) rows map to their stored tab by normalized URL when it exists. */
  const storedIds = (ids: string[]) => {
    const byNorm = new Map((snap?.tabs ?? []).map((t) => [t.normUrl, t.id]))
    return [...new Set(ids.map((i) => (i.startsWith('live:') ? byNorm.get(i.slice(5)) : i)).filter((i): i is string => !!i))]
  }
  const act = {
    open: (ids = selIds) => ctx?.openUrls(rows.filter((r) => ids.includes(r.id)).map((r) => r.url)),
    move: (ids = selIds) =>
      (ids = ids.filter((i) => !i.startsWith('live:'))).length ? setDialog({ kind: 'picker', ids }) : toast('这些标签还没存入快照，请先「立即存入」'),
    check: (ids = selIds) => (ids = ids.filter((i) => !i.startsWith('live:'))).length && ctx?.checkLinks(ids),
    summarize: (ids = selIds) => {
      if (summarizing) return
      const stored = storedIds(ids)
      if (stored.length) ctx?.summarize(stored)
      else if (ids.length) toast('所选标签还没存入快照，请先按 F5「立即快照」再生成摘要')
    },
    copy: (ids = selIds) => {
      const urls = rows.filter((r) => ids.includes(r.id)).map((r) => r.url)
      if (urls.length) void navigator.clipboard.writeText(urls.join('\n')).then(() => toast(`已复制 ${urls.length} 个链接`))
    },
    del: (ids = selIds) => {
      ids = ids.filter((i) => !i.startsWith('live:'))
      if (!ids.length) return
      if (inTrash) {
        if (confirm(`彻底删除 ${ids.length} 项？此操作不可撤销。`)) void run(() => call('trash:empty', { tabIds: ids }), `已彻底删除 ${ids.length} 项`)
      } else void run(() => call('tabs:delete', { tabIds: ids }), `已将 ${ids.length} 项移到回收站`)
      setSel(EMPTY_SEL)
    },
    restore: (ids = selIds) => ids.length && void run(() => call('trash:restore', { tabIds: ids }), `已还原 ${ids.length} 项`)
  }

  // ---- v1.3 workflows ----
  /** Re-open tabs in the browser they came from, one new window per browser, in batches of 50. */
  const restoreToOrigin = async (list: TabItem[], label: string) => {
    const http = list.filter((t) => /^https?:/i.test(t.url))
    if (!http.length) return toast('没有可还原的网页')
    if (http.length > 50 && !confirm(`将在原浏览器中还原 ${http.length} 个标签（${label}），按浏览器分批、每批 50 个新窗口打开。继续？`)) return
    const launchable = new Set(browsers.filter((b) => b.canLaunch).map((b) => b.id))
    const groups = new Map<string, string[]>()
    for (const t of http) {
      const b = t.browserId && launchable.has(t.browserId) ? t.browserId : ''
      groups.set(b, [...(groups.get(b) ?? []), t.url])
    }
    await run(async () => {
      for (const [b, urls] of groups)
        for (let i = 0; i < urls.length; i += 50) {
          const batch = urls.slice(i, i + 50)
          if (b) await call('open:in', { browserId: b, urls: batch, newWindow: true, profileId: null })
          else await call('open:urls', { urls: batch })
        }
    }, `已在原浏览器还原 ${http.length} 个标签`)
  }
  const closeOne = async (browserId: string, name: string) => {
    if (!confirm(`先把 ${name} 当前的标签保存到今日快照，然后正常关闭 ${name}（浏览器会自己保存会话，下次打开可恢复）。继续？`)) return
    const r = await run(
      () => call('capture:closeOne', { browserId }),
      (x) => (x.unread ? `${name} 已关闭，但未能读取最新会话` : `已保存 ${x.captured} 个标签并关闭 ${name}`)
    )
    if (r) {
      scan()
      void loadRecon()
    }
  }
  const onFix = (a: FixAction, r: Reconciliation) => {
    if (a === 'closeThis') void closeOne(r.browserId, r.name)
    else void snapshotNow().then(loadRecon)
  }
  const dayTabs = (sid: string) => {
    const ids = new Set(snap?.items.filter((i) => i.sessionId === sid).map((i) => i.tabId))
    return snap?.tabs.filter((t) => ids.has(t.id)) ?? []
  }
  const autoLabel = !appStatus
    ? ''
    : appStatus.autoSnapshotMinutes > 0
      ? `自动快照 · 每 ${appStatus.autoSnapshotMinutes} 分钟${appStatus.nextAutoAt ? ` · 下次 ${new Date(appStatus.nextAutoAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}` : ' · 完成首次设置后启动'}`
      : '自动快照已关闭'

  const renameFolder = async (c?: Collection) => {
    if (!c) return
    const name = await ask('重命名收藏夹', c.name)
    if (name && name !== c.name) await run(() => call('collection:update', { id: c.id, name }), '已重命名')
  }
  const newFolder = async (parentId: string | null = null) => {
    const name = await ask(parentId ? '新建子收藏夹' : '新建收藏夹', '')
    if (name) {
      const id = await run(() => call('collection:create', { name, note: '', parentId }), `已创建「${name}」`)
      if (id) setNode(`col:${id}`)
    }
  }

  const rowMenu = (): MenuItem[] => {
    if (inTrash)
      return [
        { label: '还原', icon: <RotateCcw size={sz} />, action: () => act.restore() },
        { separator: true },
        { label: '彻底删除', icon: <Trash2 size={sz} />, accel: 'Del', action: () => act.del() }
      ]
    const launchable = browsers.filter((b) => b.canLaunch)
    const urls = selRows.map((r) => r.url).filter((u) => /^https?:/i.test(u))
    return [
      { label: '打开', icon: <ExternalLink size={sz} />, accel: 'Enter', action: () => act.open() },
      {
        label: '用…打开',
        disabled: !launchable.length || !urls.length,
        submenu: launchable.map((b) => ({
          label: b.name,
          action: () => void run(() => call('open:in', { browserId: b.id, urls: urls.slice(0, 500), newWindow: true, profileId: null }))
        }))
      },
      { label: '在原浏览器还原', icon: <History size={sz} />, disabled: !urls.length, action: () => void restoreToOrigin(selRows, '所选') },
      { label: '复制链接', icon: <Copy size={sz} />, accel: 'Ctrl+C', action: () => act.copy() },
      { separator: true },
      {
        label: '移入收藏夹',
        icon: <FolderInput size={sz} />,
        submenu: [
          ...(snap?.collections ?? []).map((c) => ({ label: c.name, action: () => void ctx?.moveTo(selIds, c.id) })),
          { separator: true },
          { label: '移回未整理', action: () => void ctx?.moveTo(selIds, null) },
          { label: '新建收藏夹…', action: () => act.move() }
        ]
      },
      { label: '检查链接', icon: <CheckCircle2 size={sz} />, action: () => act.check() },
      { label: summarizing ? '正在生成摘要…' : '生成摘要', icon: <Sparkles size={sz} />, disabled: summarizing, action: () => act.summarize() },
      { separator: true },
      { label: '删除', icon: <Trash2 size={sz} />, accel: 'Del', action: () => act.del() }
    ]
  }

  const treeMenu = (id: string, x: number, y: number) => {
    let items: MenuItem[] | null = null
    if (id === 'collections') items = [{ label: '新建收藏夹…', action: () => void newFolder(null) }]
    else if (id.startsWith('col:')) {
      const c = snap?.collections.find((k) => k.id === id.slice(4))
      if (c)
        items = [
          { label: '打开全部', icon: <ExternalLink size={sz} />, action: () => ctx?.openUrls(rows.map((r) => r.url)) },
          { separator: true },
          { label: '新建子收藏夹…', action: () => void newFolder(c.id) },
          { label: '重命名', accel: 'F2', disabled: c.builtin, action: () => void renameFolder(c) },
          {
            label: '删除收藏夹',
            disabled: c.builtin,
            action: () => confirm(`删除收藏夹「${c.name}」？里面的标签会回到「未整理」。`) && void run(() => call('collection:delete', { id: c.id }), '已删除')
          }
        ]
    } else if (id.startsWith('day:') || id.startsWith('s:')) {
      const sid = id.replace(/^(day|s):/, '')
      const s = snap?.sessions.find((k) => k.id === sid)
      if (s)
        items = [
          { label: '在原浏览器还原整天', icon: <History size={sz} />, action: () => void restoreToOrigin(dayTabs(s.id), s.name) },
          { label: '打开全部', icon: <ExternalLink size={sz} />, action: () => ctx?.openUrls(rows.map((r) => r.url)) },
          { label: '重命名…', action: () => void ask('重命名', s.name).then((n) => void (n && run(() => call('session:update', { id: s.id, name: n })))) },
          { separator: true },
          {
            label: '删除此快照',
            action: () => confirm(`删除「${s.name}」？已整理进收藏夹的标签会保留。`) && void run(() => call('session:delete', { id: s.id }), '已删除')
          }
        ]
    } else if (id === 'trash')
      items = [
        { label: '全部还原', action: () => void run(() => call('trash:restore', { tabIds: snap!.trash.map((t) => t.id) }), '已还原') },
        { label: '清空回收站', action: () => confirm('清空回收站？此操作不可撤销。') && void run(() => call('trash:empty', {}), '已清空') }
      ]
    else if (id === 'unsorted') items = [{ label: '快速整理…', action: () => setDialog({ kind: 'triage' }) }]
    else if (id.startsWith('browser:')) {
      const b = browsers.find((k) => k.id === id.slice(8))
      if (b)
        items = [
          { label: `只快照并关闭 ${b.name}…`, icon: <Power size={sz} />, action: () => void closeOne(b.id, b.name) },
          { label: '数量对账', icon: <Scale size={sz} />, action: () => setNode('reconcile') }
        ]
    } else if (id === 'gone') items = [{ label: '在原浏览器全部还原', icon: <History size={sz} />, action: () => void restoreToOrigin(rows, '昨天消失') }]
    if (items) setCtxMenu({ x, y, items })
  }

  // ---- tree ----
  const tree = useMemo<TreeNode[]>(() => {
    if (!snap) return []
    const daily = snap.sessions.filter((s) => s.kind === 'daily' && s.day).sort((a, b) => (a.day! < b.day! ? 1 : -1))
    const years = new Map<string, Map<string, typeof daily>>()
    for (const s of daily) {
      const [y, m] = s.day!.split('-')
      if (!years.has(y)) years.set(y, new Map())
      const mm = years.get(y)!
      mm.set(m, [...(mm.get(m) ?? []), s])
    }
    const today = localDay()
    const other = snap.sessions.filter((s) => s.kind !== 'daily')
    // perf: one pass over tabs + one bottom-up roll-up instead of filtering all tabs per folder
    const direct = new Map<string, number>()
    for (const t of snap.tabs) if (t.collectionId) direct.set(t.collectionId, (direct.get(t.collectionId) ?? 0) + 1)
    const kidsOf = new Map<string | null, string[]>()
    for (const c of snap.collections) kidsOf.set(c.parentId ?? null, [...(kidsOf.get(c.parentId ?? null) ?? []), c.id])
    const folderCounts = new Map<string, number>()
    const roll = (id: string, seen = new Set<string>()): number => {
      if (folderCounts.has(id)) return folderCounts.get(id)!
      if (seen.has(id)) return 0
      seen.add(id)
      const n = (direct.get(id) ?? 0) + (kidsOf.get(id) ?? []).reduce((a, k) => a + roll(k, seen), 0)
      folderCounts.set(id, n)
      return n
    }
    snap.collections.forEach((c) => roll(c.id))
    const colTree = (parent: string | null): TreeNode[] =>
      snap.collections
        .filter((c) => (c.parentId ?? null) === parent)
        .map((c) => {
          const kids = colTree(c.id)
          return {
            id: `col:${c.id}`,
            label: c.name,
            icon: kids.length ? <FolderOpen size={sz} /> : <Folder size={sz} />,
            count: folderCounts.get(c.id) ?? 0,
            children: kids.length ? kids : undefined
          }
        })
    return [
      { id: 'overview', label: '概览', icon: <LayoutDashboard size={sz} /> },
      {
        id: 'browsers',
        label: '浏览器',
        icon: <Monitor size={sz} />,
        children: browsers
          .filter((b) => b.installed && b.profiles.length)
          .map((b) => {
            const stale = b.profiles.filter((p) => p.locked || p.stale)
            const warn = stale.length
              ? `${b.name} ${stale.some((p) => p.locked) ? '正在运行并锁定会话文件' : '会话文件较旧'}${stale[0].sourceMtime ? `，显示的是 ${new Date(stale[0].sourceMtime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 的快照` : ''}；安装扩展可获取实时标签`
              : undefined
            return {
              id: `browser:${b.id}`,
              label: b.name,
              icon: b.id === 'firefox' ? <Globe size={sz} /> : <Chrome size={sz} />,
              count: b.profiles.reduce((n, p) => n + p.openTabs, 0),
              warn,
              children:
                b.profiles.length > 1
                  ? b.profiles.map((p) => ({
                      id: `profile:${p.key}`,
                      label: p.profileName,
                      count: p.openTabs,
                      warn: p.locked || p.stale ? '数据可能滞后' : undefined
                    }))
                  : undefined
            }
          })
          .concat([
            {
              id: 'reconcile',
              label: '数量对账',
              icon: <Scale size={sz} />,
              warn: recon?.some((r) => r.fixes.some((f) => f !== 'snapshotNow')) ? '有浏览器的数字来自旧存档，点开查看原因' : undefined
            } as never
          ])
      },
      {
        id: 'daily',
        label: '每日快照',
        icon: <CalendarDays size={sz} />,
        count: daily.find((s) => s.day === today)?.itemCount,
        children: [
          { id: 'gone', label: '昨天消失', icon: <History size={sz} />, count: lc.disappeared.length } as TreeNode,
          ...other.map(
            (s) =>
              ({
                id: `s:${s.id}`,
                label: `导入：${s.name}`,
                icon: <Archive size={sz} />,
                count: snap.tabs.filter((t) => t.sessionId === s.id).length
              }) as TreeNode
          ),
          ...([...years].map(([y, months]) => ({
            id: `y:${y}`,
            label: `${y} 年`,
            children: [...months].map(([m, list]) => ({
              id: `m:${y}-${m}`,
              label: `${Number(m)} 月`,
              children: list.map((s) => ({
                id: `day:${s.id}`,
                label: `${Number(s.day!.slice(8))} 日${s.day === today ? '（今天）' : ''}${s.addedCount ? ` +${s.addedCount}` : ''}`,
                icon: <Calendar size={sz} />,
                count: s.itemCount
              }))
            }))
          })) as TreeNode[])
        ]
      },
      {
        id: 'collections',
        label: '收藏夹',
        icon: <Folder size={sz} />,
        children: [
          { id: 'unsorted', label: '未整理', icon: <Inbox size={sz} />, badge: snap.tabs.filter((t) => !t.collectionId).length } as TreeNode,
          ...colTree(null),
          { id: 'dedup', label: '重复项', icon: <Files size={sz} /> } as TreeNode
        ]
      },
      { id: 'autoorg', label: '智能整理', icon: <Bot size={sz} /> },
      { id: 'trash', label: '回收站', icon: <Trash2 size={sz} />, count: snap.trash.length }
    ]
  }, [snap, browsers, recon, lc])

  const nodeTitle = (() => {
    if (hits) return `${aiSearch ? '智能搜索' : '搜索'}“${query}”`
    if (node === 'view') return view?.title ?? ''
    const find = (ns: TreeNode[]): TreeNode | undefined => {
      for (const n of ns) {
        if (n.id === node) return n
        const k = n.children && find(n.children)
        if (k) return k
      }
    }
    return find(tree)?.label ?? ''
  })()

  // ---- menus ----
  const menus: TopMenu[] = [
    {
      label: '文件',
      key: 'F',
      items: [
        { label: '粘贴链接到今日快照…', accel: 'Ctrl+N', action: () => setDialog({ kind: 'paste' }) },
        { label: '导入书签 HTML…', action: () => void importHtml() },
        {
          label: '从浏览器导入书签',
          submenu: browsers.flatMap((b) =>
            b.profiles.map((p) => ({
              label: `${b.name} · ${p.profileName}`,
              action: () =>
                void run(
                  () => call('bookmarks:importBrowser', { key: p.key }),
                  (r) => `已导入 ${r.count} 个书签`
                )
            }))
          )
        },
        {
          label: '导入所有浏览器书签',
          action: () =>
            void run(
              () => call('bookmarks:importAll'),
              (r) => `已导入 ${r.count} 个书签（${r.sources.map((x) => `${x.name} ${x.count}`).join('、') || '无'}）· 跨浏览器重复 ${r.duplicates}`
            )
        },
        { separator: true },
        {
          label: '导出 JSON…',
          action: () =>
            void run(
              () => call('backup:exportJson'),
              (f) => (f ? `已导出 ${f}` : '已取消')
            )
        },
        {
          label: '导出书签 HTML…',
          action: () =>
            void run(
              () => call('backup:exportHtml'),
              (f) => (f ? `已导出 ${f}` : '已取消')
            )
        },
        {
          label: '从备份恢复…',
          action: () =>
            void run(
              () => call('backup:importJson'),
              (n) => (n === null ? '已取消' : `已恢复 ${n} 个标签`)
            )
        },
        { separator: true },
        { label: '关闭窗口', accel: 'Alt+F4', action: () => void call('window:control', { action: 'close' }) }
      ]
    },
    {
      label: '编辑',
      key: 'E',
      items: [
        {
          label: '全选',
          accel: 'Ctrl+A',
          disabled: !showGrid,
          action: () => setSel({ ids: new Set(rows.map((r) => r.id)), anchor: rows[0]?.id ?? null, focus: null })
        },
        { label: '复制链接', accel: 'Ctrl+C', disabled: !selIds.length, action: () => act.copy() },
        { label: inTrash ? '彻底删除' : '删除', accel: 'Del', disabled: !selIds.length, action: () => act.del() },
        ...(inTrash ? [{ label: '还原', disabled: !selIds.length, action: () => act.restore() }] : []),
        { separator: true },
        { label: '新建收藏夹…', action: () => void newFolder(selectedCollection?.id ?? null) },
        {
          label: '重命名收藏夹',
          accel: 'F2',
          disabled: !selectedCollection || selectedCollection.builtin,
          action: () => void renameFolder(selectedCollection)
        },
        { separator: true },
        { label: '查找', accel: 'Ctrl+F', action: () => searchRef.current?.focus() }
      ]
    },
    {
      label: '视图',
      key: 'V',
      items: [
        { label: '概览', action: () => setNode('overview') },
        { label: '今日快照', action: () => setNode('daily') },
        { label: '未整理', action: () => setNode('unsorted') },
        { label: '重复项', action: () => setNode('dedup') },
        { label: '回收站', action: () => setNode('trash') },
        { separator: true },
        { label: '属性窗格', checked: showDetails, accel: 'Alt+P', action: () => setShowDetails(!showDetails) },
        {
          label: '紧凑行高',
          checked: density === 'compact',
          action: () => void call('settings:update', { density: density === 'compact' ? 'comfortable' : 'compact' }).then(applyLook)
        },
        { separator: true },
        { label: '刷新', accel: 'Ctrl+R', action: () => (void refresh(), scan()) }
      ]
    },
    {
      label: '快照',
      key: 'S',
      items: [
        { label: '立即快照', icon: <Camera size={sz} />, accel: 'F5', action: () => void snapshotNow() },
        { label: '快照并关闭所有浏览器…', icon: <Power size={sz} />, accel: 'Ctrl+Shift+Q', action: () => setDialog({ kind: 'close' }) },
        {
          label: '只快照并关闭…',
          submenu: browsers.filter((b) => b.installed).map((b) => ({ label: b.name, action: () => void closeOne(b.id, b.name) }))
        },
        { separator: true },
        { label: '数量对账', icon: <Scale size={sz} />, action: () => setNode('reconcile') },
        { label: '粘贴链接…', accel: 'Ctrl+N', action: () => setDialog({ kind: 'paste' }) }
      ]
    },
    {
      label: '工具',
      key: 'T',
      items: [
        { label: '检查链接', disabled: !selIds.length, action: () => act.check() },
        { label: '生成 AI 摘要', disabled: !selIds.length, action: () => act.summarize() },
        { label: '快速整理未整理…', action: () => setDialog({ kind: 'triage' }) },
        { label: '查找重复项', action: () => setNode('dedup') },
        { label: '智能整理', icon: <Bot size={sz} />, action: () => setNode('autoorg') },
        { separator: true },
        {
          label: '清空所有数据…',
          action: () =>
            confirm('清空 TabNest 中的所有快照、标签和自建收藏夹？设置会保留。此操作不可撤销（建议先 文件 › 导出 JSON）。') &&
            void run(() => call('data:clearAll', { confirm: 'CLEAR' }), '已清空所有数据')
        },
        { separator: true },
        { label: '设置…', icon: <Gear size={sz} />, accel: 'Ctrl+,', action: () => setDialog({ kind: 'settings' }) }
      ]
    },
    {
      label: '帮助',
      key: 'H',
      items: [
        { label: '命令面板', accel: 'Ctrl+K', action: () => setDialog({ kind: 'palette' }) },
        { label: '键盘快捷键', action: () => setDialog({ kind: 'keys' }) },
        { label: '打开日志', action: () => void call('app:openLogs') },
        { label: '检查更新', action: () => void run(() => call('app:checkUpdates'), '已检查更新') },
        { separator: true },
        { label: '关于 TabNest', action: () => setDialog({ kind: 'settings', tab: '关于' }) }
      ]
    }
  ]

  // ---- global shortcuts ----
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (dialog) return
      const inField = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)
      const c = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (e.key === 'F5') void snapshotNow()
      else if (c && key === 'f') searchRef.current?.focus()
      else if (c && key === 'k') setDialog({ kind: 'palette' })
      else if (c && e.key === ',') setDialog({ kind: 'settings' })
      else if (c && key === 'n') setDialog({ kind: 'paste' })
      else if (c && e.shiftKey && key === 'q') setDialog({ kind: 'close' })
      else if (c && key === 'r') {
        void refresh()
        scan()
      } else if (e.altKey && key === 'p') setShowDetails(!showDetails)
      else if (e.key === 'F2' && !inField && selectedCollection && !selectedCollection.builtin) void renameFolder(selectedCollection)
      else if (c && key === 'c' && !inField && selIds.length) act.copy()
      else if (e.key === 'Escape' && inField && e.target === searchRef.current) {
        setQuery('')
        gridWrap.current?.querySelector<HTMLElement>('.grid')?.focus()
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const splitter = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = side === 'left' ? leftW : rightW
    const move = (ev: MouseEvent) => {
      const d = ev.clientX - x0
      if (side === 'left') setLeftW(Math.max(160, Math.min(480, w0 + d)))
      else setRightW(Math.max(220, Math.min(560, w0 - d)))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (error)
    return (
      <div className="boot">
        <b>无法加载数据</b>
        <p>{error}</p>
      </div>
    )
  if (!snap || !ctx) return <div className="boot">加载中…</div>

  const todayCount = snap.sessions.find((s) => s.day === localDay())?.itemCount ?? 0
  const empty =
    node === 'trash' ? (
      '回收站为空'
    ) : node.startsWith('browser:') || node.startsWith('profile:') ? (
      <>今日快照中还没有来自此浏览器的标签。按 F5 立即快照。</>
    ) : node === 'daily' ? (
      <>今天还没有快照。按 F5 读取所有浏览器的标签，或点工具栏「快照并关闭」。</>
    ) : (
      '此视图中没有项目'
    )

  return (
    <Ctx.Provider value={ctx}>
      <div className={`win density-${density}`}>
        <TitleBar title="TabNest 页签巢" />
        <MenuBar menus={menus} />
        <Toolbar
          hasSel={selIds.length > 0 && showGrid}
          inTrash={inTrash}
          query={query}
          setQuery={setQuery}
          aiSearch={aiSearch}
          setAiSearch={setAiSearch}
          onSearchEnter={() => void askAi()}
          searchRef={searchRef}
          onSnapshot={() => void snapshotNow()}
          onCloseAll={() => setDialog({ kind: 'close' })}
          onOpen={() => act.open()}
          onMove={() => act.move()}
          onCheck={() => act.check()}
          onSummarize={() => act.summarize()}
          summarizing={summarizing}
          onDelete={() => act.del()}
        />
        <div className="panes">
          <aside className="pane-left" style={{ width: leftW }}>
            <NavTree
              nodes={tree}
              selected={node}
              onSelect={(id) => {
                setNode(id)
                if (query) setQuery('')
              }}
              onContext={treeMenu}
              onRename={(id) => id.startsWith('col:') && void renameFolder(snap.collections.find((c) => c.id === id.slice(4)))}
              defaultExpanded={['browsers', 'daily', `y:${localDay().slice(0, 4)}`, `m:${localDay().slice(0, 7)}`, 'collections']}
            />
          </aside>
          <div className="splitter" onMouseDown={splitter('left')} role="separator" aria-orientation="vertical" />
          <main className="pane-center" ref={gridWrap}>
            <div className="pane-header">
              <span>{nodeTitle}</span>
              {showGrid && <span className="muted">{rows.length.toLocaleString()} 项</span>}
              {node === 'unsorted' && !hits && rows.length > 0 && (
                <button className="btn btn-sm" onClick={() => setDialog({ kind: 'triage' })}>
                  快速整理…
                </button>
              )}
              {node === 'gone' && !hits && rows.length > 0 && (
                <button className="btn btn-sm" onClick={() => void restoreToOrigin(rows, '昨天消失')}>
                  在原浏览器全部还原
                </button>
              )}
              {node.startsWith('day:') && !hits && rows.length > 0 && (
                <button className="btn btn-sm" onClick={() => void restoreToOrigin(rows, nodeTitle)}>
                  在原浏览器还原
                </button>
              )}
              {inTrash && snap.trash.length > 0 && (
                <button className="btn btn-sm" onClick={() => confirm('清空回收站？此操作不可撤销。') && void run(() => call('trash:empty', {}), '已清空')}>
                  清空回收站
                </button>
              )}
            </div>
            {hits && aiSearch && smart && (
              <SmartBar
                smart={smart}
                answer={answer}
                count={rows.length}
                onAsk={() => void askAi()}
                onCite={(id) => setSel({ ids: new Set([id]), anchor: id, focus: id })}
              />
            )}
            {live?.node === node &&
              !hits &&
              (() => {
                const today = snap.sessions.find((x) => x.day === localDay())
                const saved = new Set(
                  today ? snap.items.filter((i) => i.sessionId === today.id).map((i) => snap.tabs.find((t) => t.id === i.tabId)?.normUrl) : []
                )
                const unsaved = live.tabs.filter((l) => !saved.has(l.normUrl)).length
                return unsaved > 0 ? (
                  <div className="banner" data-testid="unsaved-banner">
                    当前打开 {live.tabs.length} 个 · 其中 {unsaved} 个尚未存入今日快照
                    <button className="btn btn-sm btn-primary" onClick={() => void snapshotNow()}>
                      立即存入
                    </button>
                  </div>
                ) : null
              })()}
            {node === 'overview' && !hits ? (
              <OverviewHome snap={snap} lc={lc} recon={recon} autoLabel={autoLabel} onGo={setNode} onTriage={() => setDialog({ kind: 'triage' })} />
            ) : node === 'reconcile' && !hits ? (
              <ReconcilePane recon={recon} loading={reconLoading} onRefresh={() => void loadRecon()} onFix={onFix} />
            ) : node === 'autoorg' && !hits ? (
              <AutoOrgPane run={run} onSettings={() => setDialog({ kind: 'settings', tab: 'AI' })} />
            ) : node === 'dedup' && !hits ? (
              <DedupView />
            ) : (
              <DataGrid
                rows={rows}
                rowHeight={density === 'compact' ? 28 : 36}
                sel={sel}
                setSel={setSel}
                onOpen={(ids) => (inTrash ? act.restore(ids) : act.open(ids))}
                onDelete={(ids) => act.del(ids)}
                onContext={(x, y) => setCtxMenu({ x, y, items: rowMenu() })}
                empty={empty}
              />
            )}
          </main>
          {showDetails && showGrid && (
            <>
              <div className="splitter" onMouseDown={splitter('right')} role="separator" aria-orientation="vertical" />
              <aside className="pane-right" style={{ width: rightW }}>
                <DetailsPane
                  row={focusRow ?? null}
                  count={selIds.length}
                  onSummarize={() => act.summarize()}
                  summarizing={summarizing}
                  onCheckLink={() => act.check()}
                  onAiSettings={() => setDialog({ kind: 'settings', tab: 'AI' })}
                />
              </aside>
            </>
          )}
        </div>
        <StatusBar
          total={showGrid ? rows.length : snap.tabs.length}
          selected={selIds.length}
          today={todayCount}
          auto={autoLabel}
          job={job}
          onCancelJob={() => job && void call('links:cancel', { jobId: job.jobId })}
        />

        {ctxMenu && <ContextMenu {...ctxMenu} onClose={() => setCtxMenu(null)} />}
        {!snap.onboardingDone && !welcomeDismissed && !dialog && (
          <WelcomeDialog
            leftover={snap.tabs.length + snap.sessions.length}
            browsers={browsers}
            onLater={() => setWelcomeDismissed(true)}
            onStart={() => {
              setWelcomeDismissed(true)
              void run(() => call('onboarding:complete', { profileKeys: [], bookmarkKeys: [], captureNow: true }), '已开始：自动快照每 30 分钟运行').then(
                () => void loadRecon()
              )
            }}
            onClear={() => {
              if (!confirm('清空所有旧数据？此操作不可撤销。')) return
              setWelcomeDismissed(true)
              void run(async () => {
                await call('data:clearAll', { confirm: 'CLEAR' })
                await call('onboarding:complete', { profileKeys: [], bookmarkKeys: [], captureNow: true })
              }, '已清空旧数据并开始')
            }}
          />
        )}
        {dialog?.kind === 'settings' && <SettingsDialog initialTab={dialog.tab} onClose={() => setDialog(null)} />}
        {dialog?.kind === 'close' && (
          <CloseBrowsersModal
            onClose={() => setDialog(null)}
            onDone={(msg, sid) => {
              setDialog(null)
              toast(msg)
              setNode(`day:${sid}`)
              scan()
            }}
          />
        )}
        {dialog?.kind === 'paste' && (
          <CaptureModal
            initialText=""
            onClose={() => setDialog(null)}
            onCreate={async (name, note, tabs) => {
              const id = await run(() => call('session:create', { name, note, tags: [], tabs }), `已并入今日快照 · ${tabs.length} 个`)
              if (id) {
                setDialog(null)
                setNode(`day:${id}`)
              }
            }}
          />
        )}
        {dialog?.kind === 'picker' && (
          <FolderPicker
            collections={snap.collections}
            count={dialog.ids.length}
            onClose={() => setDialog(null)}
            onPick={(cid) => {
              void ctx.moveTo(dialog.ids, cid)
              setDialog(null)
            }}
            onNew={async () => {
              const ids = dialog.ids
              setDialog(null)
              const name = await ask('新收藏夹名称')
              if (!name) return
              const cid = await run(() => call('collection:create', { name, note: '', parentId: null }))
              if (cid) await ctx.moveTo(ids, cid)
            }}
          />
        )}
        {dialog?.kind === 'prompt' && (
          <PromptModal
            title={dialog.title}
            initial={dialog.initial}
            onDone={(v) => {
              dialog.resolve(v || null)
              setDialog(null)
            }}
          />
        )}
        {dialog?.kind === 'triage' && (
          <TriageDialog
            tabs={snap.tabs.filter((t) => !t.collectionId)}
            collections={snap.collections}
            onClose={() => setDialog(null)}
            onCommit={async (moves, discard) => {
              setDialog(null)
              for (const m of moves) await call('tabs:moveToCollection', { tabIds: m.ids, collectionId: m.folderId })
              if (discard.length) await call('tabs:delete', { tabIds: discard })
              toast(`已整理 ${moves.reduce((n, m) => n + m.ids.length, 0)} 项，丢弃 ${discard.length} 项`)
            }}
          />
        )}
        {dialog?.kind === 'keys' && (
          <Modal
            title="键盘快捷键"
            onClose={() => setDialog(null)}
            width={420}
            footer={
              <button className="btn btn-primary" onClick={() => setDialog(null)}>
                确定
              </button>
            }
          >
            <table className="kv">
              <tbody>
                {[
                  ['F5', '立即快照'],
                  ['Ctrl+Shift+Q', '快照并关闭所有浏览器'],
                  ['Enter', '打开选中项'],
                  ['Delete', '删除（移到回收站）'],
                  ['Ctrl+A / Shift+点击 / Ctrl+点击', '全选 / 范围选择 / 多选'],
                  ['Ctrl+C', '复制链接'],
                  ['F2', '重命名收藏夹'],
                  ['Ctrl+F', '搜索'],
                  ['Ctrl+K', '命令面板'],
                  ['Ctrl+,', '设置'],
                  ['Alt / Alt+字母', '菜单栏'],
                  ['Ctrl+Shift+S', '（全局）立即快照']
                ].map(([a, b]) => (
                  <tr key={a}>
                    <td>
                      <kbd>{a}</kbd>
                    </td>
                    <td>{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Modal>
        )}
        {dialog?.kind === 'palette' && (
          <Palette
            onClose={() => setDialog(null)}
            commands={[
              { id: 'close', label: '快照并关闭所有浏览器', run: () => setDialog({ kind: 'close' }) },
              { id: 'snap', label: '立即快照（F5）', run: () => void snapshotNow() },
              { id: 'paste', label: '粘贴链接到今日快照', run: () => setDialog({ kind: 'paste' }) },
              { id: 'triage', label: '快速整理未整理', run: () => setDialog({ kind: 'triage' }) },
              { id: 'overview', label: '转到 概览', run: () => setNode('overview') },
              { id: 'daily', label: '转到 今日快照', run: () => setNode('daily') },
              { id: 'unsorted', label: '转到 未整理', run: () => setNode('unsorted') },
              { id: 'dedup', label: '转到 重复项', run: () => setNode('dedup') },
              { id: 'trash', label: '转到 回收站', run: () => setNode('trash') },
              { id: 'settings', label: '设置', run: () => setDialog({ kind: 'settings' }) }
            ]}
          />
        )}
        {toastMsg && (
          <div className="toast" role="status" aria-live="polite">
            {toastMsg}
          </div>
        )}
      </div>
    </Ctx.Provider>
  )
}
