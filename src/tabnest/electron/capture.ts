import log from 'electron-log/main'
import { discoverBrowsers, type BrowserInfo, type ProfileInfo } from './browsers/discover'
import { readBookmarks, readHistory, countBookmarks, type LiveTab } from './browsers/read'
import { captureLiveAsync } from './browsers/live-pool'
import { diffCaptures } from '../shared/diff'
import { normalizeUrl } from '../shared/url'
import { runningBrowserIds } from './close'
import type { CaptureTab, CaptureOutcome } from './db'
import type { Repo } from './db'
import type { Settings } from './settings'
import { closeBrowsers, type CloseResult } from './close'
import { runCloseFlow, strategyFor, type Strategy } from './closeflow'
import { reconcile, type Reconciliation } from '../shared/reconcile'
import { safeIso, safeMs } from '../shared/time'

export const profileKey = (p: { browserId: string; profileId: string }) => `${p.browserId}::${p.profileId}`

export interface ProfileCard {
  key: string
  browserId: string
  browserName: string
  profileName: string
  family: 'chromium' | 'firefox'
  openTabs: number
  windows: number
  bookmarks: number | null
  hasHistory: boolean
  lastActive: string | null
  selected: boolean
  error?: string
  locked: boolean
  stale: boolean
  sourceMtime: string | null
}

export interface BrowserCard {
  id: string
  name: string
  installed: boolean
  canLaunch: boolean
  profiles: ProfileCard[]
}

export interface CaptureResult extends CaptureOutcome {
  total: number
  removed: number
  byBrowser: Record<string, number>
  byBrowserId: Record<string, number>
  summary: string
  source: 'session'
}

export interface RecoveryItem {
  url: string
  title: string
  source: string
  when: string | null
  kind: 'closed' | 'history'
}

export interface ClosePreview {
  browsers: {
    id: string
    name: string
    process: string
    tabs: number
    running: boolean
    locked: boolean
    stale: boolean
    staleAt: string | null
    strategy: Strategy
  }[]
  /** locked+running browsers — recommend snapshot&close this browser */
  lockedRunning: string[]
  totalTabs: number
  note: string
}

export class CaptureService {
  private cache: { at: number; browsers: BrowserInfo[] } | null = null
  private timer: NodeJS.Timeout | null = null
  private busy = false
  /** when the next timed auto-snapshot fires (ISO), null if off */
  nextAutoAt: string | null = null
  /** called after every successful snapshot (auto-organize hook) */
  afterCapture?: () => void

  constructor(
    private repo: Repo,
    private settings: Settings,
    private onChange: () => void
  ) {}

  browsers(force = false): BrowserInfo[] {
    if (!force && this.cache && Date.now() - this.cache.at < 15000) return this.cache.browsers
    const browsers = discoverBrowsers()
    this.cache = { at: Date.now(), browsers }
    return browsers
  }

  private allProfiles(): ProfileInfo[] {
    return this.browsers().flatMap((b) => b.profiles)
  }

  selectedProfiles(): ProfileInfo[] {
    const sel = this.settings.get().selectedProfiles
    const all = this.allProfiles()
    return sel.length ? all.filter((p) => sel.includes(profileKey(p))) : all
  }

  async scan(force = false): Promise<BrowserCard[]> {
    const t0 = performance.now()
    const sel = new Set(this.settings.get().selectedProfiles)
    const browsers = this.browsers(force)
    const out: BrowserCard[] = []
    for (const b of browsers) {
      const profiles: ProfileCard[] = []
      for (const p of b.profiles) {
        const card: ProfileCard = {
          key: profileKey(p),
          browserId: p.browserId,
          browserName: p.browserName,
          profileName: p.profileName,
          family: p.family,
          openTabs: 0,
          windows: 0,
          bookmarks: null,
          hasHistory: p.hasHistory,
          lastActive: safeIso(p.lastActive),
          selected: sel.size === 0 || sel.has(profileKey(p)),
          locked: false,
          stale: false,
          sourceMtime: null
        }
        try {
          const live = await captureLiveAsync([p])
          card.openTabs = live.tabs.length
          card.windows = live.windows
          const st = live.status[profileKey(p)]
          if (st) {
            card.locked = st.locked
            card.stale = st.stale
            card.sourceMtime = safeIso(st.sourceMtime)
          }
        } catch (e) {
          card.error = String(e)
        }
        profiles.push(card)
      }
      out.push({ id: b.id, name: b.name, installed: b.installed, canLaunch: !!b.exe, profiles })
    }
    log.info(`perf: browsers:scan ${Math.round(performance.now() - t0)} ms (profiles=${out.reduce((n, b) => n + b.profiles.length, 0)})`)
    return out
  }

  countBookmarks(key: string): number {
    const p = this.allProfiles().find((x) => profileKey(x) === key)
    if (!p) return 0
    try {
      return countBookmarks(readBookmarks(p))
    } catch {
      return 0
    }
  }

  private async gather(
    profileKeys?: string[]
  ): Promise<{ tabs: LiveTab[]; byBrowser: Record<string, number>; byBrowserId: Record<string, number>; source: CaptureResult['source'] }> {
    const profiles = profileKeys?.length ? this.allProfiles().filter((p) => profileKeys.includes(profileKey(p))) : this.selectedProfiles()
    const live = await captureLiveAsync(profiles)
    const tabs = [...live.tabs]
    const byBrowser: Record<string, number> = {}
    const byBrowserId: Record<string, number> = {}
    for (const t of tabs) {
      byBrowser[t.browserName] = (byBrowser[t.browserName] ?? 0) + 1
      byBrowserId[t.browserId] = (byBrowserId[t.browserId] ?? 0) + 1
    }
    return { tabs, byBrowser, byBrowserId, source: 'session' }
  }

  /**
   * Merge the current open-tab set into today's daily snapshot (deduped by normalized URL).
   * The previous open set is remembered so we can report how many tabs the user closed.
   */
  async snapshotAll(trigger: 'manual' | 'auto' | 'shutdown', profileKeys?: string[]): Promise<CaptureResult> {
    if (this.busy) throw new Error('正在快照中，请稍候')
    this.busy = true
    try {
      const { tabs, byBrowser, byBrowserId, source } = await this.gather(profileKeys)
      // De-dupe within this capture; keep the richest title.
      const byUrl = new Map<string, LiveTab>()
      for (const t of tabs) {
        const k = normalizeUrl(t.url)
        const prev = byUrl.get(k)
        if (!prev || (t.title && t.title.length > (prev.title?.length ?? 0))) byUrl.set(k, t)
      }
      const current = [...byUrl.values()]
      const previous = JSON.parse(this.repo.getSetting('lastOpenSet') ?? '[]') as { url: string }[]
      const diff = diffCaptures(previous, current)
      // Pass every (browser, URL) pair: recordCapture merges by URL and keeps all sources for attribution.
      const captureTabs: CaptureTab[] = tabs
        .filter((t) => t.url)
        .map((t) => ({
          title: t.title,
          url: t.url,
          browserId: t.browserId,
          profileId: t.profileId,
          pinned: t.pinned,
          lastActiveAt: safeIso(t.lastActive),
          source: `${t.browserId}::${t.profileId}`
        }))
      const outcome = this.repo.recordCapture(captureTabs)
      // Track which triggers contributed to today.
      this.repo.annotateDaily(outcome.sessionId, trigger, current.length, outcome.dayTotal)
      this.repo.setSetting('lastOpenSet', JSON.stringify(current.map((t) => ({ url: t.url }))))
      this.repo.setSetting('lastCaptureAt', new Date().toISOString())
      this.onChange()
      this.afterCapture?.()
      const summary = Object.entries(byBrowser)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')
      log.info(`capture(${trigger}): open=${current.length} newToday=${outcome.newToday} newOverall=${outcome.newOverall} source=${source}`)
      return { ...outcome, captured: current.length, total: current.length, removed: diff.removed.length, byBrowser, byBrowserId, summary, source }
    } finally {
      this.busy = false
    }
  }

  /** Per-browser count reconciliation: archive vs filtered vs de-duped vs today's snapshot. */
  async reconciliation(): Promise<Reconciliation[]> {
    const browsers = this.browsers(true).filter((b) => b.installed)
    const running = await runningBrowserIds()
    const today = this.repo.dayCountByBrowser()
    const out: Reconciliation[] = []
    for (const b of browsers) {
      const live = await captureLiveAsync(b.profiles)
      const st = Object.values(live.status)
      const locked = st.some((x) => x.locked)
      const mt = Math.max(0, ...st.map((x) => safeMs(x.sourceMtime) ?? 0))
      const recentlyActive = b.profiles.some((p) => (safeMs(p.lastActive) ?? 0) > Date.now() - 10 * 60000)
      out.push(
        reconcile({
          browserId: b.id,
          name: b.name,
          running: running ? running.has(b.id) : locked || recentlyActive,
          locked,
          stale: st.some((x) => x.stale),
          archiveAt: safeIso(mt),
          rawTabs: st.reduce((n, x) => n + (x.rawTabs ?? 0), 0),
          filtered: st.reduce((n, x) => n + (x.filtered ?? 0), 0),
          deduped: new Set(live.tabs.map((t) => normalizeUrl(t.url))).size,
          inToday: today[b.id] ?? 0
        })
      )
    }
    return out
  }

  /** What a browser has open right now (from session files), de-duplicated. */
  async liveTabs(
    browserId: string,
    profileId: string | null
  ): Promise<{ url: string; normUrl: string; title: string; profileId: string; profileName: string; pinned: boolean; lastActiveAt: string | null }[]> {
    let tabs: LiveTab[] = []
    {
      const profiles = this.allProfiles().filter((p) => p.browserId === browserId && (!profileId || p.profileId === profileId))
      try {
        tabs = (await captureLiveAsync(profiles)).tabs
      } catch (e) {
        log.warn('liveTabs failed', browserId, e)
      }
    }
    const seen = new Set<string>()
    const out = []
    for (const t of tabs) {
      const normUrl = normalizeUrl(t.url)
      if (seen.has(normUrl)) continue
      seen.add(normUrl)
      out.push({
        url: t.url,
        normUrl,
        title: t.title || t.url,
        profileId: t.profileId,
        profileName: t.profileName,
        pinned: t.pinned,
        lastActiveAt: safeIso(t.lastActive)
      })
    }
    return out
  }

  /** Snapshot & close ONE browser (closing a locked browser first makes it flush its live session). */
  async snapshotAndCloseOne(browserId: string): Promise<{ captured: number; closed: CloseResult[]; unread: boolean }> {
    const preview = await this.closePreview()
    const b = preview.browsers.find((x) => x.id === browserId)
    if (!b) {
      const r = await this.snapshotAll(
        'manual',
        this.selectedProfiles()
          .filter((p) => p.browserId === browserId)
          .map(profileKey)
      )
      return { captured: r.total, closed: [], unread: false }
    }
    const keys = this.allProfiles()
      .filter((p) => p.browserId === browserId)
      .map(profileKey)
    let captured = 0
    const flow = await runCloseFlow(
      [{ ...b, profileKeys: keys }],
      {
        snapshot: async (k, _ids) => {
          this.cache = null
          const r = await this.snapshotAll('shutdown', k.length ? k : ['__none__'])
          captured += r.byBrowserId[browserId] ?? 0
          return r.byBrowserId
        },
        close: (ids) => closeBrowsers(ids)
      },
      {}
    )
    return { captured, closed: flow.closed, unread: flow.unread.length > 0 }
  }

  /** Import bookmarks from every profile that has them, under one 「书签」 root with per-source folders. */
  importAllBookmarks(): { count: number; sources: { name: string; count: number }[]; duplicates: number } {
    const sources: { name: string; count: number }[] = []
    let count = 0
    const root = this.repo.findCollectionByName('书签')?.id ?? this.repo.createCollection('书签', '所有浏览器的书签（按来源）')
    for (const p of this.allProfiles()) {
      let tree
      try {
        tree = readBookmarks(p)
      } catch {
        continue
      }
      if (!tree.length) continue
      const name = `${p.browserName}${p.profileName && p.profileName !== '默认' ? ` · ${p.profileName}` : ''}`
      const existing = this.repo.snapshot().collections.find((c) => c.parentId === root && c.name === name)
      const id = existing?.id ?? this.repo.createCollection(name, `来源：${p.browserName}`, root)
      const n = this.repo.importBookmarkTree(tree, id)
      if (n) sources.push({ name, count: n })
      count += n
    }
    const ids = new Set(this.repo.descendants(root))
    const urls = this.repo
      .snapshot()
      .tabs.filter((t) => t.collectionId && ids.has(t.collectionId))
      .map((t) => t.normUrl)
    this.onChange()
    return { count, sources, duplicates: urls.length - new Set(urls).size }
  }

  /** Preview for the "snapshot & close browsers" flow. */
  async closePreview(): Promise<ClosePreview> {
    const scan = await this.scan(true)
    const running = await runningBrowserIds()
    const browsers = scan
      .filter((b) => b.installed)
      .map((b) => {
        const locked = b.profiles.some((p) => p.locked)
        const staleMs = Math.max(0, ...b.profiles.filter((p) => p.stale && p.sourceMtime).map((p) => safeMs(p.sourceMtime) ?? 0))
        const isRunning = running ? running.has(b.id) : locked || b.profiles.some((p) => (safeMs(p.lastActive) ?? 0) > Date.now() - 10 * 60000)
        const row = {
          id: b.id,
          name: b.name,
          process: PROCESS[b.id] ?? b.id,
          tabs: b.profiles.reduce((n, p) => n + p.openTabs, 0),
          running: isRunning,
          locked,
          stale: b.profiles.some((p) => p.stale),
          staleAt: safeIso(staleMs),
          strategy: 'snapshot-then-close' as Strategy
        }
        row.strategy = strategyFor({ ...row, profileKeys: [] })
        return row
      })
      .filter((b) => b.running || b.tabs > 0)
    const lockedRunning = browsers.filter((b) => b.running && b.locked).map((b) => b.name)
    const note = lockedRunning.length
      ? `${lockedRunning.join('、')} 正在运行并锁定了当前会话文件：将先正常关闭它们（浏览器会自己保存会话），再读取并保存。也可在对账页对单个浏览器使用「只快照并关闭此浏览器」。`
      : '读取浏览器会话文件；最近几秒内刚打开、尚未写盘的标签可能漏掉。'
    return { browsers, lockedRunning, totalTabs: browsers.reduce((n, b) => n + b.tabs, 0), note }
  }

  /**
   * Snapshot & close. Readable browsers: snapshot → verify → close. Locked browsers (Edge/Vivaldi/QQ while
   * running): close gracefully FIRST → wait for exit → read the flushed session → snapshot.
   */
  async snapshotAndClose(opts: { forceEvenIfEmpty?: boolean; alsoShutdown?: boolean } = {}): Promise<{
    capture: CaptureResult
    closed: CloseResult[]
    skipped: { id: string; reason: string }[]
    unread: { id: string; name: string }[]
    shutdown: boolean
  }> {
    const preview = await this.closePreview()
    const profilesOf = (id: string) =>
      this.selectedProfiles()
        .filter((p) => p.browserId === id)
        .map(profileKey)
    let last: CaptureResult | null = null
    let total = 0
    const flow = await runCloseFlow(
      preview.browsers.map((b) => ({ ...b, profileKeys: profilesOf(b.id) })),
      {
        snapshot: async (keys, _ids) => {
          this.cache = null // re-discover: files change once a browser exits
          last = await this.snapshotAll('shutdown', keys.length ? keys : ['__none__'])
          total += last.total
          return last.byBrowserId
        },
        close: (ids) => closeBrowsers(ids)
      },
      opts
    )
    const capture = last ?? (await this.snapshotAll('shutdown'))
    if (opts.alsoShutdown && !flow.unread.length && !flow.skipped.length) {
      const { shutdownComputer } = await import('./close')
      await shutdownComputer()
    }
    return {
      capture: { ...capture, total: Object.values(flow.captured).reduce((a, b) => a + b, 0) || total },
      closed: flow.closed,
      skipped: flow.skipped,
      unread: flow.unread,
      shutdown: !!opts.alsoShutdown && !flow.unread.length && !flow.skipped.length
    }
  }

  async recovery(): Promise<RecoveryItem[]> {
    const known = this.repo.knownNormUrls()
    const out = new Map<string, RecoveryItem>()
    const profiles = this.selectedProfiles()
    const live = await captureLiveAsync(profiles, true)
    const open = new Set(live.tabs.map((t) => normalizeUrl(t.url)))
    for (const c of live.closed) {
      const k = normalizeUrl(c.url)
      if (known.has(k) || open.has(k) || out.has(k)) continue
      out.set(k, {
        url: c.url,
        title: c.title,
        source: `${c.browserName} · 最近关闭`,
        when: safeIso(c.lastActive),
        kind: 'closed'
      })
    }
    if (this.settings.get().captureHistory) {
      for (const p of profiles) {
        if (!p.hasHistory) continue
        try {
          for (const h of readHistory(p, 7)) {
            const k = normalizeUrl(h.url)
            if (!/^https?:/.test(h.url) || known.has(k) || open.has(k) || out.has(k)) continue
            out.set(k, { url: h.url, title: h.title, source: `${p.browserName} · 历史记录`, when: h.lastVisit, kind: 'history' })
          }
        } catch (e) {
          log.warn('history read failed', p.path, e)
        }
      }
    }
    return [...out.values()].slice(0, 3000)
  }

  importBookmarks(key: string): { count: number; collectionId: string } {
    const p = this.allProfiles().find((x) => profileKey(x) === key)
    if (!p) throw new Error('找不到这个浏览器配置文件')
    const tree = readBookmarks(p)
    if (!tree.length) throw new Error(`${p.browserName} 里没有书签`)
    const rootName = `${p.browserName} 书签${p.profileName && p.profileName !== '默认' ? ` · ${p.profileName}` : ''}`
    const root = this.repo.findCollectionByName(rootName)?.id ?? this.repo.createCollection(rootName, `从 ${p.browserName} 导入，保留原有文件夹结构`)
    const count = this.repo.importBookmarkTree(tree, root)
    this.onChange()
    return { count, collectionId: root }
  }

  schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const min = this.settings.get().autoSnapshotMinutes
    this.nextAutoAt = null
    // Auto-snapshot is on by default and no longer waits for onboarding (1.2.0 had no onboarding UI → it never ran).
    if (min > 0) {
      this.nextAutoAt = new Date(Date.now() + min * 60000).toISOString()
      this.timer = setInterval(() => {
        this.nextAutoAt = new Date(Date.now() + min * 60000).toISOString()
        void this.snapshotAll('auto').catch((e) => log.error('auto snapshot failed', e))
      }, min * 60000)
      this.timer.unref()
    }
  }
}

const PROCESS: Record<string, string> = {
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  brave: 'brave.exe',
  vivaldi: 'vivaldi.exe',
  opera: 'opera.exe',
  chromium: 'chrome.exe',
  qqbrowser: 'QQBrowser.exe',
  '360se': '360se.exe',
  '360chrome': '360ChromeX.exe',
  sogou: 'SogouExplorer.exe',
  '2345': '2345Explorer.exe',
  liebao: 'liebao.exe',
  quark: 'quark.exe',
  lenovo: 'SLBrowser.exe',
  firefox: 'firefox.exe'
}
