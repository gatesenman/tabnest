export type LinkStatus = 'unknown' | 'ok' | 'redirect' | 'broken' | 'timeout' | 'checking'

export interface TabItem {
  id: string
  sessionId: string | null
  collectionId: string | null
  title: string
  url: string
  normUrl: string
  domain: string
  favicon: string
  createdAt: string
  groupName: string | null
  description: string
  keywords: string[]
  linkStatus: LinkStatus
  linkStatusCode: number | null
  linkStatusNote: string | null
  lastCheckedAt: string | null
  browserId: string | null
  profileId: string | null
  pinned: boolean
  lastActiveAt: string | null
  note: string
  /** when it was moved into a folder (triage), null for unsorted / imported bookmarks */
  organizedAt: string | null
  /** AI enrichment (v1.3.1) */
  topics?: string[]
  summary?: string
  lang?: string
  enrichedAt?: string | null
  enrichedBy?: 'local' | 'cloud' | null
  /** title/url changed since last enrichment → queued for re-enrichment */
  enrichStale?: boolean
  /** why AI put it in its folder ("依据：域名 github.com → 代码托管；关键词 react") */
  orgReason?: string | null
}

export interface Session {
  id: string
  name: string
  createdAt: string
  note: string
  tags: string[]
  groupNames: Record<string, string>
  kind: 'manual' | 'auto' | 'extension' | 'import' | 'history' | 'daily'
  sourceSummary: string
  /** For daily snapshots: items not present in the previous day's snapshot. */
  addedCount: number
  removedCount: number
  /** Local day (YYYY-MM-DD) for daily snapshots. */
  day: string | null
  itemCount: number
}

export interface SnapshotItem {
  sessionId: string
  tabId: string
  title: string
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
  sources: string[]
}

export interface Collection {
  id: string
  name: string
  createdAt: string
  note: string
  builtin: boolean
  parentId: string | null
  sort: number
}

export interface Snapshot {
  sessions: Session[]
  collections: Collection[]
  tabs: TabItem[]
  items: SnapshotItem[]
  trash: (TabItem & { deletedAt: string })[]
  onboardingDone: boolean
}

export interface DuplicateGroup {
  normUrl: string
  tabs: TabItem[]
}

export type ThemeSource = 'system' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

export interface PublicSettings {
  theme: ThemeSource
  density: Density
  linkCheckConcurrency: number
  linkCheckTimeoutMs: number
  backupDir: string
  autoBackup: boolean
  launchAtLogin: boolean
  autoUpdate: boolean
  autoSnapshotMinutes: number
  shutdownAfterClose: boolean
  captureHistory: boolean
  selectedProfiles: string[] // `${browserId}::${profileId}`
  aiBaseUrl: string
  aiModel: string
  autoOrganize: boolean
  autoOrganizeThreshold: number
  groupThreshold?: number
  aiCloudOrganize: boolean
  /** fetch page content for AI (off = fully offline) */
  aiFetchPages: boolean
  previewAuto: boolean
  /** cloud tokens per day, 0 = unlimited */
  aiDailyTokenCap: number
  /** OpenAI-compatible embedding model ('' = off) */
  aiEmbedModel: string
  hasAiKey: boolean
  aiKeyEncryptionAvailable: boolean
  dataPath: string
  logPath: string
  version: string
  onboardingDone: boolean
}

export interface NewTabInput {
  title: string
  url: string
  browserId?: string | null
  profileId?: string | null
  pinned?: boolean
  lastActiveAt?: string | null
}

export interface LinkCheckProgress {
  jobId: string
  done: number
  total: number
  tabId?: string
  status?: LinkStatus
  finished?: boolean
  cancelled?: boolean
}

export const BUILTIN_FOLDERS = [
  { name: '稍后阅读', note: '有空再慢慢看' },
  { name: '工作', note: '工作相关链接' },
  { name: '学习', note: '学习与教程' },
  { name: '归档', note: '暂时用不到，但不想丢' },
  { name: '未分类', note: '暂时放这里' }
] as const
