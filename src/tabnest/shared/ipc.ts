import { z } from 'zod'

const id = z.string().min(1).max(64)
const ids = z.array(id).max(20000)
const httpUrl = z
  .string()
  .max(8192)
  .refine((u) => /^https?:\/\//i.test(u), 'only http(s) URLs are allowed')
const tabInput = z.object({ title: z.string().max(2000), url: httpUrl })
const profileKey = z.string().min(3).max(500)

/** Every invokable channel and the schema of its single payload argument. */
export const invokeSchemas = {
  'data:snapshot': z.void(),
  'session:create': z.object({
    name: z.string().min(1).max(200),
    note: z.string().max(2000).default(''),
    tags: z.array(z.string().max(50)).max(30).default([]),
    tabs: z.array(tabInput).max(20000)
  }),
  'session:update': z.object({
    id,
    name: z.string().min(1).max(200).optional(),
    note: z.string().max(2000).optional(),
    tags: z.array(z.string().max(50)).max(30).optional(),
    groupNames: z.record(z.string().max(300), z.string().max(200)).optional()
  }),
  'session:delete': z.object({ id }),
  'tabs:setGroup': z.object({ tabIds: ids, groupName: z.string().max(200).nullable() }),
  'tabs:moveToCollection': z.object({ tabIds: ids, collectionId: id.nullable() }),
  'tabs:delete': z.object({ tabIds: ids }),
  'tabs:update': z.object({ id, note: z.string().max(10000).optional(), title: z.string().min(1).max(2000).optional() }),
  'trash:restore': z.object({ tabIds: ids }),
  'trash:empty': z.object({ tabIds: ids.optional() }),
  'collection:create': z.object({ name: z.string().min(1).max(200), note: z.string().max(2000).default(''), parentId: id.nullable().default(null) }),
  'collection:move': z.object({ id, parentId: id.nullable() }),
  'tabs:restore': z.object({
    tabs: z
      .array(
        z
          .object({
            id,
            sessionId: id.nullable(),
            collectionId: id.nullable(),
            title: z.string().max(2000),
            url: httpUrl,
            createdAt: z.string().max(40)
          })
          .passthrough()
      )
      .max(5000)
  }),
  'browsers:scan': z.object({ force: z.boolean().default(false) }),
  'browsers:bookmarkCount': z.object({ key: profileKey }),
  'capture:now': z.object({ profileKeys: z.array(profileKey).max(100).optional() }),
  'capture:closePreview': z.void(),
  'capture:closeAndSnapshot': z.object({ forceEvenIfEmpty: z.boolean().default(false), alsoShutdown: z.boolean().default(false) }),
  'capture:recovery': z.void(),
  'capture:recover': z.object({ items: z.array(tabInput).min(1).max(5000) }),
  'bookmarks:importBrowser': z.object({ key: profileKey }),
  'onboarding:complete': z.object({ profileKeys: z.array(profileKey).max(100), bookmarkKeys: z.array(profileKey).max(100), captureNow: z.boolean() }),
  'open:in': z.object({
    browserId: z.string().min(1).max(40),
    urls: z.array(httpUrl).min(1).max(500),
    newWindow: z.boolean().default(true),
    profileId: z.string().max(300).nullable().default(null)
  }),
  'stats:get': z.void(),
  'stale:list': z.object({ days: z.number().int().min(1).max(365).default(7) }),
  'window:control': z.object({ action: z.enum(['minimize', 'maximize', 'close']) }),
  'collection:update': z.object({ id, name: z.string().min(1).max(200).optional(), note: z.string().max(2000).optional() }),
  'collection:delete': z.object({ id }),
  'collection:clear': z.object({ id }),
  'search:query': z.object({ q: z.string().max(500), limit: z.number().int().min(1).max(5000).default(500) }),
  'search:ai': z.object({ q: z.string().max(500), limit: z.number().int().min(1).max(2000).default(200) }),
  'ai:enrichStatus': z.void(),
  'search:smart': z.object({ q: z.string().max(500), limit: z.number().int().min(1).max(2000).default(300), cloud: z.boolean().default(true) }),
  'ai:ask': z.object({ q: z.string().min(1).max(500) }),
  'ai:test': z.void(),
  'ai:usage': z.void(),
  'ai:digest': z.void(),
  'ai:explain': z.object({ id }),
  'preview:info': z.object({ url: z.string().min(1).max(4000) }),
  'preview:refresh': z.object({ url: z.string().min(1).max(4000) }),
  'preview:stats': z.void(),
  'preview:clear': z.void(),
  'dedup:near': z.void(),
  'dedup:mergeNear': z.object({ keys: z.array(z.string().max(9000)).max(5000).optional() }),
  'org:renameUpgrade': z.void(),
  'dedup:find': z.void(),
  'dedup:merge': z.object({ keepId: id, removeIds: ids }),
  'links:check': z.object({ tabIds: ids }),
  'links:cancel': z.object({ jobId: id }),
  'ai:summarize': z.object({ tabIds: ids }),
  'open:urls': z.object({ urls: z.array(httpUrl).min(1).max(500) }),
  'bookmarks:import': z.object({ mode: z.enum(['session', 'collections']) }),
  'backup:exportJson': z.void(),
  'backup:exportHtml': z.void(),
  'backup:importJson': z.void(),
  'backup:now': z.void(),
  'settings:get': z.void(),
  'settings:update': z
    .object({
      theme: z.enum(['system', 'light', 'dark']),
      density: z.enum(['comfortable', 'compact']),
      autoSnapshotMinutes: z.number().int().min(0).max(1440),
      shutdownAfterClose: z.boolean(),
      captureHistory: z.boolean(),
      selectedProfiles: z.array(profileKey).max(100),
      linkCheckConcurrency: z.number().int().min(1).max(20),
      linkCheckTimeoutMs: z.number().int().min(1000).max(60000),
      autoBackup: z.boolean(),
      launchAtLogin: z.boolean(),
      autoUpdate: z.boolean(),
      aiBaseUrl: z.string().url().max(500),
      aiModel: z.string().min(1).max(100),
      autoOrganize: z.boolean(),
      autoOrganizeThreshold: z.number().min(0.5).max(0.99),
      groupThreshold: z.number().int().min(3).max(50),
      aiCloudOrganize: z.boolean(),
      aiFetchPages: z.boolean(),
      previewAuto: z.boolean(),
      aiDailyTokenCap: z.number().int().min(0).max(100_000_000),
      aiEmbedModel: z.string().max(100)
    })
    .partial(),
  'settings:setAiKey': z.object({ key: z.string().max(500).nullable() }),
  'settings:chooseBackupDir': z.void(),
  'app:checkUpdates': z.void(),
  'app:openLogs': z.void(),
  'app:status': z.void(),
  'reconcile:get': z.void(),
  'org:status': z.void(),
  'org:run': z.object({ review: z.boolean().default(false) }),
  'org:undo': z.object({ id }),
  'org:undoToday': z.void(),
  'org:accept': z.object({ tabIds: ids }),
  'org:dismiss': z.object({ tabIds: ids }),
  'org:deleteRule': z.object({ id: z.string().min(1).max(64) }),
  'browsers:liveTabs': z.object({ browserId: z.string().min(1).max(40), profileId: z.string().max(200).nullable().default(null) }),
  'capture:closeOne': z.object({ browserId: z.string().min(1).max(40) }),
  'bookmarks:importAll': z.void(),
  'data:clearAll': z.object({ confirm: z.literal('CLEAR') })
} as const

export type InvokeChannel = keyof typeof invokeSchemas
export type InvokeInput<C extends InvokeChannel> = z.input<(typeof invokeSchemas)[C]>

export const INVOKE_CHANNELS = Object.keys(invokeSchemas) as InvokeChannel[]

/** Main → renderer events. */
export const EVENT_CHANNELS = ['data:changed', 'linkcheck:progress', 'ui:quickCapture', 'ui:navigate', 'ui:toast', 'window:state', 'capture:done'] as const
export type EventChannel = (typeof EVENT_CHANNELS)[number]
