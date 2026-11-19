import type { Reconciliation } from '../shared/reconcile'
import type { InvokeChannel, InvokeInput } from '../shared/ipc'
import type { Collection, DuplicateGroup, LinkCheckProgress, PublicSettings, Snapshot } from '../shared/types'

interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
  platform: string
}

declare global {
  interface Window {
    tabnest?: Bridge
  }
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
    strategy: 'snapshot-then-close' | 'close-then-read'
  }[]
  lockedRunning: string[]
  totalTabs: number
  note: string
}
export interface CaptureSummary {
  sessionId: string
  day: string
  total: number
  newToday: number
  dayTotal: number
  byBrowser: Record<string, number>
  source: 'session'
}
export interface CloseOutcome {
  capture: CaptureSummary
  closed: { id: string; process: string; closed: boolean; forced: boolean; error?: string }[]
  skipped: { id: string; reason: string }[]
  unread: { id: string; name: string }[]
  shutdown: boolean
}

export interface ProfileCardUI {
  key: string
  browserId: string
  browserName: string
  profileName: string
  family: 'chromium' | 'firefox'
  openTabs: number
  windows: number
  hasHistory: boolean
  lastActive: string | null
  selected: boolean
  error?: string
  locked: boolean
  stale: boolean
  sourceMtime: string | null
}
export interface BrowserCardUI {
  id: string
  name: string
  installed: boolean
  canLaunch: boolean
  profiles: ProfileCardUI[]
}

export interface OrgStatus {
  enabled: boolean
  threshold: number
  engine: 'local' | 'cloud'
  cloudEnabled: boolean
  cloudReady: boolean
  model: string
  siteCount: number
  lastRunAt: string | null
  lastError: string | null
  lastReviewDay: string | null
  undescribed: number
  enrichment?: { total: number; enriched: number; cloud: number; pending: number; fetched?: number }
  rules: { id: string; kind: 'domain' | 'keyword'; match: string; folderName: string; hits: number; createdAt: string }[]
  pending: { tabId: string; title: string; domain: string; target: string; confidence: number; reason: string; engine: string; kind?: 'tab' | 'bookmark' }[]
  log: {
    id: string
    at: string
    kind: string
    summary: string
    engine: string
    undone: boolean
    count: number
    target?: 'tab' | 'bookmark' | 'mixed'
    why?: string[]
  }[]
  duplicates?: number
}

export type SmartChip = { kind: 'time' | 'browser' | 'folder' | 'site' | 'status'; label: string }
export interface SmartResultUI {
  items: { id: string; score: number; matched: string[] }[]
  chips: SmartChip[]
  terms: string[]
  question: boolean
  ms: number
  total: number
  rewritten?: string[]
}
export interface AskResultUI {
  source: 'cloud' | 'local'
  answer: string | null
  cites: { n: number; id: string; title: string }[]
  search: SmartResultUI
  error?: string
}
export interface NearDupGroupUI {
  key: string
  kind: 'exact' | 'url' | 'title'
  reason: string
  keepId: string
  items: { id: string; title: string; url: string; collectionId: string | null }[]
}
export interface DigestUI {
  from: string
  to: string
  added: number
  addedPrev: number
  organized: number
  topTopics: { name: string; count: number }[]
  topSites: { name: string; site: string; count: number }[]
  stale: { kind: 'readLater' | 'unsorted' | 'dead' | 'dup'; label: string; count: number; ids: string[] }[]
}
export interface PreviewInfoUI {
  url: string
  status: 'ok' | 'failed' | 'pending' | 'none'
  capturedAt: string | null
  error: string | null
  bytes: number
}
export interface ExplainUI {
  stored: string | null
  live: { target: string; confidence: number; basis: string[] } | null
  page: {
    content: string
    fetchStatus: string | null
    fetchedAt: string | null
    hasEmb: boolean
    points: string[]
    summarySrc: string | null
    engine: string | null
    summarizedAt: string | null
  } | null
  cloud: { configured: boolean; label: string | null }
}
export interface UsageUI {
  day: string
  tokens: number
  requests: number
  cacheHits: number
  cap: number
  costUsd: number | null
  model: string
}

export interface Outputs {
  'bookmarks:importBrowser': { count: number; collectionId: string }
  'browsers:scan': BrowserCardUI[]
  'app:status': { updateConfigured: boolean; autoSnapshotMinutes: number; lastCaptureAt: string | null; nextAutoAt: string | null }
  'reconcile:get': Reconciliation[]
  'org:status': OrgStatus
  'org:run': { moved: number; pending: number; ops: number }
  'org:undo': boolean
  'org:undoToday': number
  'org:accept': number
  'browsers:liveTabs': { url: string; normUrl: string; title: string; profileId: string; profileName: string; pinned: boolean; lastActiveAt: string | null }[]
  'capture:closeOne': { captured: number; closed: { id: string; ok: boolean }[]; unread: boolean }
  'bookmarks:importAll': { count: number; sources: { name: string; count: number }[]; duplicates: number }
  'data:clearAll': boolean
  'capture:closePreview': ClosePreview
  'capture:closeAndSnapshot': CloseOutcome
  'capture:now': CaptureSummary
  'data:snapshot': Snapshot
  'session:create': string
  'collection:create': string
  'search:query': string[]
  'search:ai': { id: string; score: number; matched: string[] }[]
  'ai:enrichStatus': { total: number; enriched: number; cloud: number; pending: number; fetched: number }
  'search:smart': SmartResultUI
  'ai:ask': AskResultUI
  'ai:test': { ok: boolean; ms: number; model: string; embed: boolean | null; error?: string }
  'ai:usage': UsageUI
  'ai:digest': DigestUI
  'ai:explain': ExplainUI
  'preview:info': PreviewInfoUI
  'preview:refresh': PreviewInfoUI
  'preview:stats': { count: number; bytes: number; failed: number }
  'preview:clear': number
  'dedup:near': NearDupGroupUI[]
  'dedup:mergeNear': { groups: number; removed: number; logId: string | null }
  'org:renameUpgrade': number
  'dedup:find': DuplicateGroup[]
  'links:check': { jobId: string; total: number }
  'ai:summarize': { count: number; missing: number; source: 'local' | 'cloud'; reason: string }
  'open:urls': number
  'bookmarks:import': { count: number; sessionId: string } | null
  'backup:exportJson': string | null
  'backup:exportHtml': string | null
  'backup:importJson': number | null
  'backup:now': string
  'settings:get': PublicSettings
  'settings:update': PublicSettings
  'settings:setAiKey': PublicSettings
  'settings:chooseBackupDir': PublicSettings
}
type Out<C extends InvokeChannel> = C extends keyof Outputs ? Outputs[C] : void

function bridge(): Bridge {
  if (!window.tabnest) throw new Error('TabNest 必须在桌面应用中运行')
  return window.tabnest
}

/** Error messages from main arrive wrapped as "Error invoking remote method 'x': Error: msg". */
function clean(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e)
  return new Error(m.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
}

export async function call<C extends InvokeChannel>(channel: C, ...args: InvokeInput<C> extends void ? [] : [InvokeInput<C>]): Promise<Out<C>> {
  try {
    return (await bridge().invoke(channel, args[0])) as Out<C>
  } catch (e) {
    throw clean(e)
  }
}

export function onEvent(channel: 'data:changed', cb: () => void): () => void
export function onEvent(channel: 'linkcheck:progress', cb: (p: LinkCheckProgress) => void): () => void
export function onEvent(channel: 'ui:quickCapture', cb: (p: { text: string }) => void): () => void
export function onEvent(channel: 'ui:navigate' | 'ui:toast', cb: (p: string) => void): () => void
export function onEvent(channel: 'capture:done', cb: (p: unknown) => void): () => void
export function onEvent(channel: 'window:state', cb: (p: { maximized: boolean; frameless: boolean; platform: string }) => void): () => void
export function onEvent(channel: string, cb: (p: never) => void): () => void {
  return window.tabnest ? window.tabnest.on(channel, cb as (p: unknown) => void) : () => undefined
}

export type { Collection }
