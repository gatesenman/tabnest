# TabNest 开发文档

## 环境

- Node.js 20+、npm 9+
- 不需要 C++ 编译器：`better-sqlite3` 使用官方为 Electron 预编译的二进制，`postinstall` 会执行 `electron-builder install-app-deps` 自动下载
- Linux 打包 `.deb` 不需要额外工具（electron-builder 自带 fpm）；运行 AppImage 需要 `libfuse2`

```bash
npm install
npm run dev
```

## 目录结构

```
electron/          主进程（Node）
  main.ts          启动：单实例、日志、崩溃处理、窗口、托盘、菜单、快捷键、自动更新、开机自启
  db.ts            SQLite 仓储：迁移、增删改查、FTS5 搜索、去重、备份导入导出、旧 JSON 迁移（不依赖 electron，可单测）
  ipc.ts           IPC 处理：每个通道都先用 zod 校验
  linkcheck.ts     链接检查（HEAD→GET、超时、并发池、取消）
  ai.ts            云端 AI 摘要（OpenAI 兼容接口），失败时回退到本地算法
  settings.ts      偏好设置、配对码、safeStorage 加密密钥
  backup.ts        每日备份、HTML 书签导出
  window-state.ts  记住窗口位置和大小
  preload.ts       沙箱 preload：只有通道白名单
shared/            主进程和渲染进程共用的纯 TS 代码
  ipc.ts           IPC 通道约定和 zod schema（唯一权威定义）
  types.ts / url.ts / bookmarks.ts / ai-heuristic.ts / suggest.ts
src/               渲染进程（React）
  App.tsx          外壳、导航、弹窗、事件订阅
  views/           会话 / 未整理 / 收藏夹 / 搜索 / 重复 / 设置
  components/      虚拟列表 TabList、批量操作栏、弹窗
tests/             Vitest 单元测试
e2e/               Playwright Electron 冒烟测试
build/             安装包图标（由 build/icon.svg 生成：npm run icons）
resources/         运行时资源（托盘图标、窗口图标）
```

## 数据模型

一个标签对应 `tabs` 表中的一行：

- `session_id`：来自哪个快照（历史记录，可为空，例如从备份导入的孤立项）
- `collection_id`：归入的收藏夹；**为空表示在「未整理」中**

整理只是给标签设置 `collection_id`，不会复制数据。删除会话时，已整理的标签会保留在收藏夹里（`session_id` 置空），未整理的会一起删除。

`tabs_fts` 是 FTS5 虚拟表（`tokenize='trigram'`），由触发器保持同步。查询词少于 3 个字符时（trigram 无法匹配），改用 `LIKE`。

### 新增迁移

在 `electron/db.ts` 的 `MIGRATIONS` 数组**末尾**追加 SQL 即可。启动时会在事务里执行所有序号大于 `PRAGMA user_version` 的迁移。**不要修改已经发布的迁移。**

## IPC 安全模型

1. `shared/ipc.ts` 定义了所有通道以及对应的 zod schema
2. `electron/preload.ts` 运行在沙箱中，不能引用本地模块，所以把通道白名单复制了一份；`tests/ipc.test.ts` 会检查两份是否一致
3. 主进程收到调用时，先拒绝来自子 frame 的请求，再用 zod 校验参数，然后才调用处理函数
4. 渲染进程只能通过 `src/api.ts` 里带类型的 `call(channel, payload)` 访问主进程

新增通道的步骤：在 `shared/ipc.ts` 加 schema → 在 `electron/ipc.ts` 加 handler（TypeScript 会强制要求）→ 在 preload 白名单里加上 → 如果有返回值，在 `src/api.ts` 的 `Outputs` 里加类型。

## 质量检查

| 命令 | 内容 |
|---|---|
| `npm run typecheck` | `tsc --noEmit`（strict 模式） |
| `npm run lint` | ESLint（typescript-eslint、react-hooks） |
| `npm run format:check` / `npm run format` | Prettier 检查 / 自动格式化 |
| `npm test` | Vitest，**在 Electron 内置的 Node 中运行**（`ELECTRON_RUN_AS_NODE=1`），这样数据库测试使用的 better-sqlite3 二进制和应用完全一致，不用来回重新编译 |
| `npm run test:e2e` | 构建后运行 Playwright 冒烟测试：启动真实应用（临时数据目录），检查安全设置、种子数据、整理操作、扩展 API 配对 |
| `npm run verify` | 上面除 e2e 外的全部检查 + 构建 |

无图形界面的 Linux 上运行 e2e：`xvfb-run --auto-servernum npx playwright test`。

调试时可以设置环境变量 `TABNEST_USER_DATA=/tmp/x` 来使用独立的数据目录。

## 打包与发布

```bash
npm run dist:linux   # release/1.0.0/*.AppImage, *.deb
npm run dist:win     # 需要在 Windows 上运行（或使用 CI）
npm run dist:mac     # 需要在 macOS 上运行
```

配置在 `electron-builder.yml`：appId `com.tabnest.app`，产品名 `TabNest`，显示名「TabNest 页签巢」。

发布流程：

1. 更新 `package.json` 的 `version` 和 `CHANGELOG.md`
2. `git tag v1.0.1 && git push --tags`
3. `.github/workflows/release.yml` 会先运行全部检查，再在 Ubuntu / Windows / macOS 上分别打包，并把安装包和 `latest*.yml` 发布到 GitHub Release
4. 已安装的客户端会通过 electron-updater 检测到新版本

**自动更新的仓库地址**：修改 `electron-builder.yml` 中的 `publish.owner` / `publish.repo`。目前是占位值 `tabnest/tabnest`。

### 代码签名（可选，需要证书）

在仓库的 Secrets 中配置以下变量，CI 会自动签名；不配置则生成未签名的安装包：

| Secret | 用途 |
|---|---|
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows Authenticode 证书（base64 编码的 .pfx 及密码） |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | macOS Developer ID Application 证书 |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS 公证（notarization） |

macOS 的自动更新**要求应用已签名**；Windows 未签名时也可以更新，但会触发 SmartScreen 提示。

## 日志

使用 electron-log，日志文件位置：Linux `~/.config/TabNest/logs/main.log`，macOS `~/Library/Logs/TabNest/main.log`，Windows `%APPDATA%\TabNest\logs\main.log`。


## v1.1 每日快照与关闭浏览器

### 数据模型
- `sessions.kind = 'daily'` + `sessions.day = 'YYYY-MM-DD'`（本地日历日）
- `snapshot_items(session_id, tab_id, title, first_seen_at, last_seen_at, seen_count, sources JSON)`
- `Repo.recordCapture(tabs)`：同一天 upsert；库内已有同 `norm_url` 的 tab（含已整理）会被复用，收藏夹关联不变
- 迁移 6 `mergeSessionsPerDay`：把旧的 manual/auto/extension/history 会话按 `localDay(created_at)` 折叠

### 关闭浏览器流程
`CaptureService.snapshotAndClose` → `runCloseFlow`（可读：先快照后关；锁定：先关后读）→ `snapshotAll('shutdown')` → `closeBrowsers(ids)`（`electron/close.ts`）→ 可选 `shutdownComputer`

### 扩展桥
浏览器扩展与本地配对 API 已在 1.3.5 移除；锁定浏览器请用「只快照并关闭此浏览器」。
