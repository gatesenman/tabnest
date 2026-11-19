import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  protocol,
  session,
  shell,
  Tray
} from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import trayIconPath from '../resources/tray.png?asset'
import appIconPath from '../resources/icon.png?asset'
import { Repo } from './db'
import { CaptureService } from './capture'
import { Settings } from './settings'
import { registerIpc } from './ipc'
import { AutoOrganizer, cloudClassifier } from './autoorg'
import { AiService } from './ai/service'
import { enrichJobs, disposeAiPool } from './ai/ai-pool'
import { existsSync as fileExists, readFileSync as readFileText } from 'node:fs'
import { dailyBackupIfNeeded } from './backup'
import { loadWindowState, trackWindowState } from './window-state'
import { disposeLivePool } from './browsers/live-pool'
import { PreviewService } from './preview'
import { createCapture } from './preview-capture'
import { decodePreviewKey, PREVIEW_SCHEME } from '../shared/preview'
import { pathToFileURL } from 'node:url'

// ---------- logging & crash handling ----------
log.initialize()
log.transports.file.level = 'info'
crashReporter.start({ uploadToServer: false })
process.on('uncaughtException', (e) => log.error('uncaughtException', e))
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e))
Object.assign(console, log.functions)

if (process.env.TABNEST_USER_DATA) app.setPath('userData', process.env.TABNEST_USER_DATA)
// tabnest-preview://img/<base64url(url)> serves cached page thumbnails to the renderer (must be registered before ready)
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
let previewDispose: (() => void) | null = null

const isDev = !app.isPackaged
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let capture: CaptureService | null = null
const frameless = process.platform !== 'darwin' || process.env.TABNEST_FRAMELESS === '1'

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  void app.whenReady().then(boot)
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function broadcast(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function snapshotNow(trigger: 'manual' | 'auto', notify = true): Promise<void> {
  if (!capture) return
  try {
    const t0 = performance.now()
    const r = await capture.snapshotAll(trigger)
    log.info(`perf: snapshot(${trigger}) ${Math.round(performance.now() - t0)} ms`)
    broadcast('capture:done', r)
    if (notify && (!win || !win.isVisible() || !win.isFocused()) && Notification.isSupported())
      new Notification({
        title: 'TabNest 已快照',
        body: r.newToday ? `新增 ${r.newToday} 个标签 · 当前打开 ${r.total} 个` : `今日无新增 · 共 ${r.dayTotal} 个`,
        silent: true
      }).show()
  } catch (e) {
    log.error('snapshot failed', e)
  }
}

function quickCapture(): void {
  showWindow()
  broadcast('ui:quickCapture', { text: clipboard.readText().slice(0, 500000) })
}

function openDb(): Repo {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'tabnest.db')
  const fresh = !existsSync(file)
  const repo = new Repo(file)
  if (fresh) {
    // Migrate the pre-1.0 JSON store automatically, from userData or the dev-time ./data folder.
    const candidates = [join(dir, 'data', 'tabnest.json'), join(dir, 'tabnest.json')]
    if (isDev && !process.env.TABNEST_USER_DATA) candidates.push(join(process.cwd(), 'data', 'tabnest.json'))
    const legacy = candidates.find((f) => existsSync(f))
    if (legacy) {
      try {
        const n = repo.importLegacyJson(JSON.parse(readFileSync(legacy, 'utf-8')))
        renameSync(legacy, legacy + '.migrated')
        log.info(`imported ${n} tabs from legacy ${legacy}`)
      } catch (e) {
        log.error('legacy import failed', e)
      }
    }
  }
  return repo
}

function applyLoginItem(enabled: boolean): void {
  if (process.platform === 'linux') {
    const dir = join(homedir(), '.config', 'autostart')
    const file = join(dir, 'tabnest.desktop')
    if (enabled) {
      mkdirSync(dir, { recursive: true })
      const exec = process.env.APPIMAGE || process.execPath
      writeFileSync(file, `[Desktop Entry]\nType=Application\nName=TabNest 页签巢\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`)
    } else if (existsSync(file)) unlinkSync(file)
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
  }
}

function buildMenu(): void {
  const send = (view: string) => () => (showWindow(), broadcast('ui:navigate', view))
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        { label: '立即快照全部浏览器', accelerator: 'CmdOrCtrl+Shift+S', click: () => void snapshotNow('manual') },
        { label: '粘贴链接快照…', accelerator: 'CmdOrCtrl+Shift+V', click: quickCapture },
        { label: '导入书签 HTML…', click: send('import') },
        { type: 'separator' },
        { label: '导出备份 (JSON)…', click: send('export-json') },
        { label: '导出书签 (HTML)…', click: send('export-html') },
        { label: '从备份恢复…', click: send('import-json') },
        { type: 'separator' },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => ((quitting = true), app.quit()) }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '首页', accelerator: 'CmdOrCtrl+1', click: send('home') },
        { label: '收件箱', accelerator: 'CmdOrCtrl+2', click: send('inbox') },
        { label: '时间线', accelerator: 'CmdOrCtrl+3', click: send('timeline') },
        { label: '收藏夹', accelerator: 'CmdOrCtrl+4', click: send('collections') },
        { label: '命令面板', accelerator: 'CmdOrCtrl+K', click: send('palette') },
        { label: '搜索', accelerator: 'CmdOrCtrl+F', click: send('search') },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(isDev ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }] : [])
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新', click: () => checkUpdates(true) },
        { label: '打开日志目录', click: () => shell.showItemInFolder(log.transports.file.getFile().path) },
        {
          label: '关于 TabNest',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: `TabNest 页签巢 v${app.getVersion()}`,
              detail: '先快照 → 关浏览器 → 有空再整理\n数据完全保存在本机。'
            })
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function buildTray(): void {
  try {
    const img = nativeImage.createFromPath(trayIconPath)
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    tray.setToolTip('TabNest 页签巢')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 TabNest', click: showWindow },
        { label: '立即快照全部浏览器', click: () => void snapshotNow('manual') },
        { label: '快照并关闭浏览器…', click: () => (showWindow(), broadcast('ui:navigate', 'close-browsers')) },
        { label: '粘贴链接快照…', click: quickCapture },
        { type: 'separator' },
        { label: '退出', click: () => ((quitting = true), app.quit()) }
      ])
    )
    tray.on('click', showWindow)
  } catch (e) {
    log.warn('tray unavailable', e)
  }
}

let updaterReady = false
/** The build ships with a placeholder GitHub repo (tabnest/tabnest); never hit it (404 noise). */
export function updateConfigured(): boolean {
  if (!app.isPackaged) return false
  const f = join(process.resourcesPath, 'app-update.yml')
  if (!fileExists(f)) return false
  const y = readFileText(f, 'utf-8')
  return !(/owner:\s*tabnest\b/.test(y) && /repo:\s*tabnest\b/.test(y))
}
function checkUpdates(manual: boolean): void {
  if (app.isPackaged && !updateConfigured()) {
    if (manual) void dialog.showMessageBox({ message: '未配置更新源', detail: '此版本未设置发布仓库，暂不支持自动更新。' })
    return
  }
  if (!app.isPackaged) {
    if (manual) void dialog.showMessageBox({ message: '开发模式下不检查更新' })
    return
  }
  if (!updaterReady) {
    autoUpdater.logger = log
    autoUpdater.autoDownload = true
    autoUpdater.on('update-downloaded', (i) => {
      void dialog
        .showMessageBox({ type: 'info', buttons: ['立即重启', '稍后'], message: `新版本 ${i.version} 已下载`, detail: '重启后完成更新。' })
        .then((r) => {
          if (r.response === 0) {
            quitting = true
            autoUpdater.quitAndInstall()
          }
        })
    })
    autoUpdater.on('error', (e) => log.warn('updater', e))
    updaterReady = true
  }
  autoUpdater
    .checkForUpdates()
    .then((r) => {
      if (manual && (!r || r.updateInfo.version === app.getVersion())) void dialog.showMessageBox({ message: '已是最新版本' })
    })
    .catch((e: unknown) => manual && void dialog.showMessageBox({ type: 'warning', message: '检查更新失败', detail: String(e) }))
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function createWindow(repo: Repo): BrowserWindow {
  const state = loadWindowState(repo)
  const w = new BrowserWindow({
    ...(Number.isFinite(state.bounds.x) ? { x: state.bounds.x, y: state.bounds.y } : {}),
    width: state.bounds.width,
    height: state.bounds.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'TabNest 页签巢',
    frame: !frameless,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: frameless,
    icon: appIconPath,
    backgroundColor: process.platform === 'win32' ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    // Windows 11 Mica; older Windows ignores it and shows the solid CSS background.
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  if (state.maximized) w.maximize()
  trackWindowState(w, repo)
  const sendState = () => w.webContents.send('window:state', { maximized: w.isMaximized(), frameless, platform: process.platform })
  w.on('maximize', sendState)
  w.on('unmaximize', sendState)
  w.webContents.on('did-finish-load', sendState)
  // Windows: capture right before logoff / shutdown.
  w.on('session-end', () => void snapshotNow('auto', false))
  w.once('ready-to-show', () => {
    log.info(`perf: first paint (ready-to-show) ${Math.round(performance.now())} ms after process start`)
    if (process.env.TABNEST_E2E) return void w.showInactive()
    if (!process.argv.includes('--hidden')) w.show()
  })
  w.on('close', (e) => {
    // Closing the window keeps TabNest in the tray.
    if (!quitting && tray) {
      e.preventDefault()
      w.hide()
    }
  })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (!(isDev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))) e.preventDefault()
  })
  w.webContents.on('render-process-gone', (_e, d) => log.error('renderer gone', d))
  if (isDev && process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(__dirname, '../renderer/index.html'))
  return w
}

function boot(): void {
  app.setAppUserModelId('com.tabnest.app')
  app.on('child-process-gone', (_e, d) => log.error('child gone', d))
  hardenSession()
  const repo = openDb()
  const settings = new Settings(repo)
  const dataPath = join(app.getPath('userData'), 'tabnest.db')
  const logPath = log.transports.file.getFile().path

  const applySettings = () => {
    const s = settings.get()
    nativeTheme.themeSource = s.theme
    try {
      applyLoginItem(s.launchAtLogin)
    } catch (e) {
      log.warn('login item', e)
    }
  }
  applySettings()
  importAiConfig(settings)

  capture = new CaptureService(repo, settings, () => broadcast('data:changed'))
  const ai = new AiService(
    repo,
    () => settings.get(),
    () => settings.getAiKey(),
    (msg) => broadcast('ui:toast', msg)
  )
  const organizer = new AutoOrganizer(
    repo,
    () => settings.get(),
    () => broadcast('data:changed'),
    () => (ai.cloudCfg() ? cloudClassifier(ai.cloud) : null)
  )
  organizer.hooks = {
    pipeline: (jobs, fetchPages) => enrichJobs(jobs, fetchPages),
    enrichBatch: (items) => ai.enrichBatch(items),
    embed: (texts) => ai.embed(texts),
    userActive: () => powerMonitor.getSystemIdleTime() < 120,
    online: () => net.isOnline()
  }
  let orgTimer: ReturnType<typeof setTimeout> | undefined
  capture.afterCapture = () => {
    if (!settings.get().autoOrganize) return
    clearTimeout(orgTimer)
    orgTimer = setTimeout(() => void organizer.organize('snapshot').catch((e) => log.warn('auto-organize failed', e)), 800)
  }
  organizer.start()
  const cap = createCapture()
  previewDispose = cap.dispose
  const previews = new PreviewService(repo.db, app.getPath('userData'), cap.capture, {
    enabled: () => settings.get().previewAuto && net.isOnline() && !process.env.TABNEST_E2E,
    userActive: () => powerMonitor.getSystemIdleTime() < 120,
    onChange: () => broadcast('data:changed'),
    concurrency: 1
  })
  protocol.handle(PREVIEW_SCHEME, async (req) => {
    try {
      const key = new URL(req.url).pathname.replace(/^\//, '')
      const file = previews.pathFor(decodePreviewKey(key))
      if (!file) return new Response(null, { status: 404 })
      const r = await net.fetch(pathToFileURL(file).toString())
      return new Response(r.body, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' } })
    } catch {
      return new Response(null, { status: 400 })
    }
  })
  try {
    previews.sweep()
  } catch (e) {
    log.warn('preview sweep', e)
  }
  previews.start()
  registerIpc({
    previews,
    repo,
    settings,
    getWindow: () => win,
    broadcast,
    applySettings,
    checkUpdates,
    logPath,
    dataPath,
    capture,
    organizer,
    ai,
    updateConfigured
  })
  buildMenu()
  buildTray()
  win = createWindow(repo)
  if (!globalShortcut.register('CommandOrControl+Shift+S', () => void snapshotNow('manual'))) log.warn('global shortcut taken')
  capture.schedule()
  // Never lose tabs: snapshot on sleep / shutdown, and shortly after start (catches what was open last time).
  powerMonitor.on('suspend', () => void snapshotNow('auto', false))
  powerMonitor.on('shutdown', () => void snapshotNow('auto', false))
  powerMonitor.on('lock-screen', () => {
    if (settings.get().autoSnapshotMinutes > 0) void snapshotNow('auto', false)
  })
  // Take today's snapshot automatically on startup — the user should never see counts with an empty snapshot.
  if (!process.env.TABNEST_E2E) setTimeout(() => void snapshotNow('auto', false), 3000).unref()

  if (settings.get().autoBackup) {
    dailyBackupIfNeeded(repo, settings.get().backupDir)
    setInterval(() => settings.get().autoBackup && dailyBackupIfNeeded(repo, settings.get().backupDir), 3 * 3600 * 1000).unref()
  }
  if (settings.get().autoUpdate && updateConfigured()) setTimeout(() => checkUpdates(false), 10000)

  app.on('activate', showWindow)
  app.on('before-quit', () => (quitting = true))
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    disposeLivePool()
    disposeAiPool()
    previewDispose?.()
    repo.close()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * One-shot provisioning for admins: TABNEST_IMPORT_AI_CONFIG=<path to JSON {key, baseUrl, model, cap}>.
 * The key is stored only via safeStorage (OS keychain); the file is deleted afterwards and the key is never logged.
 */
function importAiConfig(settings: Settings): void {
  const file = process.env.TABNEST_IMPORT_AI_CONFIG
  if (!file) return
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { key?: string; baseUrl?: string; model?: string; cap?: number }
    if (raw.key) settings.setAiKey(raw.key.trim())
    settings.update({
      aiCloudOrganize: true,
      ...(raw.baseUrl ? { aiBaseUrl: raw.baseUrl } : {}),
      ...(raw.model ? { aiModel: raw.model } : {}),
      ...(typeof raw.cap === 'number' ? { aiDailyTokenCap: raw.cap } : {})
    })
    log.info(`ai config imported (baseUrl=${raw.baseUrl ?? '-'}, model=${raw.model ?? '-'}, key=${raw.key ? 'set' : 'unchanged'})`)
  } catch (e) {
    log.warn('ai config import failed', e instanceof Error ? e.message : 'error')
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}
