import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { PreviewService } from './preview'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import log from 'electron-log/main'
import { invokeSchemas, type InvokeChannel } from '../shared/ipc'
import { parseBookmarkHtml } from '../shared/bookmarks'
import { defaultSessionName } from '../shared/url'
import type { LinkCheckProgress } from '../shared/types'
import type { Repo } from './db'
import type { Settings } from './settings'
import type { CaptureService } from './capture'
import { openIn } from './launch'
import type { AutoOrganizer } from './autoorg'
import { checkLink, runPool } from './linkcheck'
import type { AiService } from './ai/service'
import { buildHtmlExport, writeBackup } from './backup'

export interface IpcContext {
  repo: Repo
  settings: Settings
  getWindow: () => BrowserWindow | null
  broadcast: (channel: string, payload?: unknown) => void
  applySettings: () => void
  checkUpdates: (manual: boolean) => void
  logPath: string
  dataPath: string
  capture: CaptureService
  organizer: AutoOrganizer
  ai: AiService
  updateConfigured: () => boolean
  previews: PreviewService
}

type Handler = (input: never) => unknown

const jobs = new Map<string, AbortController>()

export function registerIpc(ctx: IpcContext): void {
  const { repo, settings } = ctx
  const changed = () => ctx.broadcast('data:changed')
  // Re-sort freshly imported bookmarks into AI folders (moves only when 自动整理 is on; otherwise they become suggestions).
  const organizeImported = () =>
    void ctx.organizer
      .organize('import')
      .then(() => changed())
      .catch(() => undefined)
  const win = () => ctx.getWindow() ?? undefined

  const handlers: { [C in InvokeChannel]: Handler } = {
    'data:snapshot': () => repo.snapshot(),
    'session:create': (p: { name: string; note: string; tags: string[]; tabs: { title: string; url: string }[] }) => {
      // Pasted links are a manual capture → merged into today's daily snapshot.
      const r = repo.recordCapture(p.tabs.map((t) => ({ ...t, source: 'paste' })))
      repo.annotateDaily(r.sessionId, 'manual', p.tabs.length, r.dayTotal)
      changed()
      return r.sessionId
    },
    'session:update': (p: Parameters<Repo['updateSession']>[0]) => (repo.updateSession(p), changed()),
    'session:delete': (p: { id: string }) => (repo.deleteSession(p.id), changed()),
    'tabs:setGroup': (p: { tabIds: string[]; groupName: string | null }) => (repo.setGroup(p.tabIds, p.groupName), changed()),
    'tabs:moveToCollection': (p: { tabIds: string[]; collectionId: string | null }) => {
      const n = repo.moveToCollection(p.tabIds, p.collectionId)
      repo.setPlacedBy(p.tabIds, p.collectionId ? 'user' : null)
      // A manual move is a correction: learn domain / keyword → folder rules.
      ctx.organizer.learn(p.tabIds, p.collectionId)
      changed()
      return n
    },
    'tabs:delete': (p: { tabIds: string[] }) => (repo.trashTabs(p.tabIds), changed()),
    'tabs:update': (p: { id: string; note?: string; title?: string }) => (repo.updateTab(p.id, p), changed()),
    'trash:restore': (p: { tabIds: string[] }) => (repo.restoreFromTrash(p.tabIds), changed()),
    'trash:empty': (p: { tabIds?: string[] }) => (repo.emptyTrash(p.tabIds), changed()),
    'collection:create': (p: { name: string; note: string; parentId: string | null }) => {
      const id = repo.createCollection(p.name, p.note, p.parentId)
      changed()
      return id
    },
    'collection:move': (p: { id: string; parentId: string | null }) => (repo.moveCollection(p.id, p.parentId), changed()),
    'tabs:restore': (p: { tabs: Parameters<Repo['insertTabs']>[0] }) => (repo.insertTabs(p.tabs), changed()),
    'browsers:scan': (p: { force: boolean }) => ctx.capture.scan(p.force),
    'browsers:bookmarkCount': (p: { key: string }) => ctx.capture.countBookmarks(p.key),
    'capture:now': async (p: { profileKeys?: string[] }) => {
      const r = await ctx.capture.snapshotAll('manual', p.profileKeys)
      ctx.broadcast('capture:done', r)
      return r
    },
    'capture:closePreview': () => ctx.capture.closePreview(),
    'capture:closeAndSnapshot': async (p: { forceEvenIfEmpty: boolean; alsoShutdown: boolean }) => {
      const r = await ctx.capture.snapshotAndClose(p)
      ctx.broadcast('capture:done', r.capture)
      return r
    },
    'capture:recovery': () => ctx.capture.recovery(),
    'capture:recover': (p: { items: { title: string; url: string }[] }) => {
      const id = repo.createSession({
        name: `找回 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        note: '从最近关闭 / 历史记录中找回',
        kind: 'history',
        tabs: p.items
      })
      changed()
      return id
    },
    'bookmarks:importBrowser': (p: { key: string }) => {
      const r = ctx.capture.importBookmarks(p.key)
      organizeImported()
      return r
    },
    'onboarding:complete': async (p: { profileKeys: string[]; bookmarkKeys: string[]; captureNow: boolean }) => {
      settings.update({ selectedProfiles: p.profileKeys })
      let bookmarks = 0
      const errors: string[] = []
      for (const k of p.bookmarkKeys) {
        try {
          bookmarks += ctx.capture.importBookmarks(k).count
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e))
        }
      }
      const capture = p.captureNow ? await ctx.capture.snapshotAll('manual') : null
      settings.setOnboardingDone()
      ctx.capture.schedule()
      changed()
      if (bookmarks) organizeImported()
      return { bookmarks, capture, errors }
    },
    'open:in': (p: { browserId: string; urls: string[]; newWindow: boolean; profileId: string | null }) =>
      openIn(p.browserId, p.urls, p.newWindow, p.profileId),
    'stats:get': () => repo.stats(),
    'stale:list': (p: { days: number }) => repo.staleTabs(p.days).map((t) => t.id),
    'window:control': (p: { action: 'minimize' | 'maximize' | 'close' }) => {
      const w = ctx.getWindow()
      if (!w) return
      if (p.action === 'minimize') w.minimize()
      else if (p.action === 'maximize') {
        if (w.isMaximized()) w.unmaximize()
        else w.maximize()
      } else w.close()
    },
    'collection:update': (p: { id: string; name?: string; note?: string }) => (repo.updateCollection(p), changed()),
    'collection:delete': (p: { id: string }) => (repo.deleteCollection(p.id), changed()),
    'collection:clear': (p: { id: string }) => (repo.clearCollection(p.id), changed()),
    'search:query': (p: { q: string; limit: number }) => repo.search(p.q, p.limit).map((t) => t.id),
    'dedup:find': () => repo.findDuplicates(),
    'dedup:merge': (p: { keepId: string; removeIds: string[] }) => {
      const g = repo.ai.nearDuplicates().find((x) => x.items.some((i) => i.id === p.keepId))
      if (!g || !p.removeIds.every((id) => g.items.some((i) => i.id === id))) throw new Error('只能合并同一组重复项')
      const d = repo.mergeDuplicates(p.keepId, p.removeIds, false)
      repo.logOrg('dedupe', `合并重复 1 组，移除 ${d.trashed?.length ?? 0} 项到回收站`, d)
      changed()
    },
    'links:check': (p: { tabIds: string[] }) => {
      const jobId = randomUUID()
      const ctrl = new AbortController()
      jobs.set(jobId, ctrl)
      const tabs = repo.getTabs(p.tabIds)
      const { linkCheckConcurrency, linkCheckTimeoutMs } = settings.get()
      let done = 0
      const progress = (x: Partial<LinkCheckProgress>) =>
        ctx.broadcast('linkcheck:progress', { jobId, done, total: tabs.length, ...x } satisfies LinkCheckProgress)
      progress({})
      void runPool(tabs, linkCheckConcurrency, ctrl.signal, async (t) => {
        const r = await checkLink(t.url, linkCheckTimeoutMs, ctrl.signal)
        repo.setLinkStatus(t.id, r)
        done++
        progress({ tabId: t.id, status: r.status })
      }).finally(() => {
        jobs.delete(jobId)
        progress({ finished: true, cancelled: ctrl.signal.aborted })
        changed()
      })
      return { jobId, total: tabs.length }
    },
    'links:cancel': (p: { jobId: string }) => {
      jobs.get(p.jobId)?.abort()
      return true
    },
    'ai:summarize': async (p: { tabIds: string[] }) => {
      // Same content-aware pipeline as background enrichment (fetch page → extract → keywords → cloud if enabled).
      const s = settings.get()
      const count = await ctx.organizer.describeSome(p.tabIds.length, undefined, p.tabIds)
      const tabs = repo.getTabs(p.tabIds)
      const cloud = tabs.filter((t) => t.enrichedBy === 'cloud').length
      const d = ctx.organizer.lastDescribe
      const cloudOn = s.aiCloudOrganize && !!settings.getAiKey()
      const reason = [
        d?.engines.length ? d.engines.join(' + ') : cloudOn ? '云端 AI' : '本地摘要',
        d ? `内容来源：${[d.page ? `网页正文 ${d.page}` : '', d.title ? `标题/网址 ${d.title}` : ''].filter(Boolean).join('，')}` : '',
        !s.aiFetchPages ? '离线模式（未读取网页）' : '',
        d?.cloudError ? `云端失败已用本地补齐：${d.cloudError}` : ''
      ]
        .filter(Boolean)
        .join(' · ')
      log.info(`ai:summarize count=${count} cloud=${cloud} page=${d?.page ?? 0}`)
      changed()
      return { count, missing: p.tabIds.length - tabs.length, source: cloud ? 'cloud' : 'local', reason }
    },
    'open:urls': async (p: { urls: string[] }) => {
      let n = 0
      for (const u of p.urls) {
        try {
          await shell.openExternal(u)
          n++
        } catch (e) {
          log.warn('open failed', u, e)
        }
        await new Promise((r) => setTimeout(r, p.urls.length > 20 ? 250 : 150))
      }
      return n
    },
    'bookmarks:import': async (p: { mode: 'session' | 'collections' }) => {
      const r = await dialog.showOpenDialog(win()!, {
        title: '导入书签 HTML',
        filters: [{ name: '书签 HTML', extensions: ['html', 'htm'] }],
        properties: ['openFile']
      })
      if (r.canceled || !r.filePaths[0]) return null
      const items = parseBookmarkHtml(readFileSync(r.filePaths[0], 'utf-8'))
      if (!items.length) throw new Error('未解析到书签，请确认是浏览器导出的 HTML 书签文件')
      const sid = repo.createSession({ name: `书签导入 ${defaultSessionName()}`, note: `从 ${r.filePaths[0]} 导入`, tabs: [] })
      if (p.mode === 'session') {
        repo.insertTabs(items.map((b) => ({ ...b, sessionId: sid, collectionId: null })))
      } else {
        const ids = new Map<string, string>()
        for (const b of items) {
          const name = b.folder || '未分类'
          if (!ids.has(name)) ids.set(name, repo.findCollectionByName(name)?.id ?? repo.createCollection(name))
        }
        repo.insertTabs(items.map((b) => ({ ...b, sessionId: sid, collectionId: ids.get(b.folder || '未分类')! })))
      }
      changed()
      return { count: items.length, sessionId: sid }
    },
    'backup:exportJson': async () => {
      const r = await dialog.showSaveDialog(win()!, {
        defaultPath: `tabnest-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return null
      writeFileSync(r.filePath, JSON.stringify(repo.exportAll(), null, 2), 'utf-8')
      return r.filePath
    },
    'backup:exportHtml': async () => {
      const r = await dialog.showSaveDialog(win()!, {
        defaultPath: `tabnest-bookmarks-${new Date().toISOString().slice(0, 10)}.html`,
        filters: [{ name: '书签 HTML', extensions: ['html'] }]
      })
      if (r.canceled || !r.filePath) return null
      writeFileSync(r.filePath, buildHtmlExport(repo), 'utf-8')
      return r.filePath
    },
    'backup:importJson': async () => {
      const r = await dialog.showOpenDialog(win()!, {
        title: '从备份恢复（合并）',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (r.canceled || !r.filePaths[0]) return null
      const n = repo.importBackup(JSON.parse(readFileSync(r.filePaths[0], 'utf-8')))
      changed()
      return n
    },
    'backup:now': () => writeBackup(repo, settings.get().backupDir),
    'settings:get': () => settings.public(ctx.dataPath, ctx.logPath),
    'settings:update': (p: Record<string, unknown>) => {
      settings.update(p)
      ctx.applySettings()
      ctx.capture.schedule()
      return settings.public(ctx.dataPath, ctx.logPath)
    },
    'settings:setAiKey': (p: { key: string | null }) => {
      settings.setAiKey(p.key)
      return settings.public(ctx.dataPath, ctx.logPath)
    },
    'settings:chooseBackupDir': async () => {
      const r = await dialog.showOpenDialog(win()!, { properties: ['openDirectory', 'createDirectory'] })
      if (!r.canceled && r.filePaths[0]) settings.update({ backupDir: r.filePaths[0] })
      return settings.public(ctx.dataPath, ctx.logPath)
    },
    'app:checkUpdates': () => ctx.checkUpdates(true),
    'app:openLogs': () => shell.showItemInFolder(ctx.logPath),
    'app:status': () => ({
      updateConfigured: ctx.updateConfigured(),
      autoSnapshotMinutes: settings.get().autoSnapshotMinutes,
      lastCaptureAt: repo.getSetting('lastCaptureAt'),
      nextAutoAt: ctx.capture.nextAutoAt
    }),
    'reconcile:get': () => ctx.capture.reconciliation(),
    'org:status': () => ctx.organizer.status(),
    'search:ai': (p: { q: string; limit: number }) => repo.aiSearch(p.q, p.limit).map((x) => ({ id: x.tab.id, score: x.score, matched: x.matched })),
    'ai:enrichStatus': () => repo.enrichmentStats(),
    'search:smart': (p: { q: string; limit: number; cloud: boolean }) => ctx.ai.smartSearch(p.q, p.limit, p.cloud),
    'ai:ask': (p: { q: string }) => ctx.ai.ask(p.q),
    'ai:test': () => ctx.ai.cloud.test(),
    'ai:usage': () => ctx.ai.usage(),
    'ai:digest': () => ctx.ai.digest(),
    'preview:info': (p: { url: string }) => ctx.previews.info(p.url),
    'preview:refresh': (p: { url: string }) => ctx.previews.refresh(p.url),
    'preview:stats': () => ctx.previews.stats(),
    'preview:clear': () => ctx.previews.clear(),
    'ai:explain': (p: { id: string }) => ctx.ai.explain(p.id, ctx.organizer.rules()),
    'dedup:near': () =>
      repo.ai.nearDuplicates().map((g) => ({
        key: g.key,
        kind: g.kind,
        reason: g.reason,
        keepId: g.keepId,
        items: g.items.map((x) => ({ id: x.id, title: x.title, url: x.url, collectionId: x.collectionId }))
      })),
    'dedup:mergeNear': (p: { keys?: string[] }) => ctx.organizer.mergeDuplicates(p.keys),
    'org:renameUpgrade': () => ctx.organizer.upgradeFolderNames(true),
    'org:run': async (p: { review: boolean }) => {
      const r = await ctx.organizer.organize('manual')
      const ops = p.review ? ctx.organizer.review(true) : []
      return { ...r, ops: ops.length }
    },
    'org:undo': (p: { id: string }) => ctx.organizer.undo(p.id),
    'org:undoToday': () => ctx.organizer.undoToday(),
    'org:accept': (p: { tabIds: string[] }) => ctx.organizer.acceptPending(p.tabIds),
    'org:dismiss': (p: { tabIds: string[] }) => ctx.organizer.dismissPending(p.tabIds),
    'org:deleteRule': (p: { id: string }) => ctx.organizer.deleteRule(p.id),
    'browsers:liveTabs': (p: { browserId: string; profileId: string | null }) => ctx.capture.liveTabs(p.browserId, p.profileId),
    'capture:closeOne': async (p: { browserId: string }) => {
      const r = await ctx.capture.snapshotAndCloseOne(p.browserId)
      changed()
      return r
    },
    'bookmarks:importAll': () => {
      const r = ctx.capture.importAllBookmarks()
      organizeImported()
      return r
    },
    'data:clearAll': () => {
      repo.clearAllData()
      changed()
      return true
    }
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      // Only accept calls from our own top-level window.
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('forbidden')
      const parsed = invokeSchemas[channel].safeParse(raw)
      if (!parsed.success) {
        log.warn('ipc validation failed', channel, parsed.error.issues)
        throw new Error(`参数无效：${parsed.error.issues[0]?.message ?? channel}`)
      }
      try {
        return await (handlers[channel] as (i: unknown) => unknown)(parsed.data)
      } catch (e) {
        log.error('ipc error', channel, e)
        throw e
      }
    })
  }
}
