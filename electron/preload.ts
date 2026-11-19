import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// Sandboxed preload: no imports beyond 'electron'. Channel lists are duplicated from shared/ipc.ts
// on purpose (sandboxed preloads cannot require local modules) and a unit test keeps them in sync.
export const INVOKE_WHITELIST = [
  'data:snapshot',
  'session:create',
  'session:update',
  'session:delete',
  'tabs:setGroup',
  'tabs:moveToCollection',
  'tabs:delete',
  'tabs:update',
  'trash:restore',
  'trash:empty',
  'collection:create',
  'collection:move',
  'tabs:restore',
  'browsers:scan',
  'browsers:bookmarkCount',
  'capture:now',
  'capture:closePreview',
  'capture:closeAndSnapshot',
  'capture:recovery',
  'capture:recover',
  'bookmarks:importBrowser',
  'onboarding:complete',
  'open:in',
  'stats:get',
  'stale:list',
  'window:control',
  'collection:update',
  'collection:delete',
  'collection:clear',
  'search:query',
  'dedup:find',
  'dedup:merge',
  'links:check',
  'links:cancel',
  'ai:summarize',
  'open:urls',
  'bookmarks:import',
  'backup:exportJson',
  'backup:exportHtml',
  'backup:importJson',
  'backup:now',
  'settings:get',
  'settings:update',
  'settings:setAiKey',
  'settings:chooseBackupDir',
  'app:checkUpdates',
  'app:openLogs',
  'app:status',
  'reconcile:get',
  'org:status',
  'org:run',
  'org:undo',
  'org:undoToday',
  'org:accept',
  'org:dismiss',
  'org:deleteRule',
  'browsers:liveTabs',
  'capture:closeOne',
  'bookmarks:importAll',
  'search:ai',
  'ai:enrichStatus',
  'search:smart',
  'ai:ask',
  'ai:test',
  'ai:usage',
  'ai:digest',
  'ai:explain',
  'preview:info',
  'preview:refresh',
  'preview:stats',
  'preview:clear',
  'dedup:near',
  'dedup:mergeNear',
  'org:renameUpgrade',
  'data:clearAll'
] as const
export const EVENT_WHITELIST = ['data:changed', 'linkcheck:progress', 'ui:quickCapture', 'ui:navigate', 'ui:toast', 'window:state', 'capture:done'] as const

const api = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!(INVOKE_WHITELIST as readonly string[]).includes(channel)) return Promise.reject(new Error(`blocked channel ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel: string, cb: (payload: unknown) => void): () => void {
    if (!(EVENT_WHITELIST as readonly string[]).includes(channel)) throw new Error(`blocked event ${channel}`)
    const h = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('tabnest', api)
