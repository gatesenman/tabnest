/**
 * Generates a realistic, throwaway database ONLY for README/DESIGN screenshots.
 * Never used by the app at runtime (the app ships with no seed data).
 *   ELECTRON_RUN_AS_NODE=1 electron node_modules/tsx/dist/cli.mjs scripts/screenshot-data.ts <dir>
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Repo } from '../electron/db'

const dir = process.argv[2]
if (!dir) throw new Error('usage: screenshot-data.ts <userDataDir>')
mkdirSync(dir, { recursive: true })
const repo = new Repo(join(dir, 'tabnest.db'))

const T: [string, string, string][] = [
  ['electron/electron: Build cross-platform desktop apps', 'https://github.com/electron/electron', 'chrome::Default'],
  ['Pull requests · tabnest/tabnest', 'https://github.com/tabnest/tabnest/pulls', 'chrome::Default'],
  ['BrowserWindow | Electron', 'https://www.electronjs.org/docs/latest/api/browser-window', 'chrome::Default'],
  ['better-sqlite3 API 文档', 'https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md', 'chrome::Default'],
  ['SQLite FTS5 Extension', 'https://www.sqlite.org/fts5.html', 'chrome::Default'],
  ['Fluent 2 Design System', 'https://fluent2.microsoft.design/', 'edge::Default'],
  ['Mica material - Windows apps | Microsoft Learn', 'https://learn.microsoft.com/windows/apps/design/style/mica', 'edge::Default'],
  ['TanStack Virtual', 'https://tanstack.com/virtual/latest', 'chrome::Default'],
  ['React 文档 - 学习 React', 'https://zh-hans.react.dev/learn', 'chrome::Default'],
  ['Vite 中文文档', 'https://cn.vitejs.dev/guide/', 'chrome::Default'],
  ['Playwright Electron', 'https://playwright.dev/docs/api/class-electron', 'chrome::Default'],
  ['MDN Web Docs: Fetch API', 'https://developer.mozilla.org/zh-CN/docs/Web/API/Fetch_API', 'firefox::default-release'],
  ['阮一峰的网络日志 — 科技爱好者周刊', 'https://www.ruanyifeng.com/blog/2026/10/weekly-issue-370.html', 'firefox::default-release'],
  ['少数派 - 高效工作，品质生活', 'https://sspai.com/', 'edge::Default'],
  ['如何系统地整理浏览器标签页？ - 知乎', 'https://www.zhihu.com/question/31846279', 'edge::Default'],
  ['V2EX › 分享创造', 'https://www.v2ex.com/go/create', 'chrome::Default'],
  ['Hacker News', 'https://news.ycombinator.com/', 'firefox::default-release'],
  ['【技术分享】Electron 应用性能优化实战_哔哩哔哩', 'https://www.bilibili.com/video/BV1xx411c7mD', 'edge::Default'],
  ['Notion – 产品路线图 Q4', 'https://www.notion.so/tabnest/Roadmap-Q4-2026', 'chrome::Default'],
  ['Figma – TabNest 1.2 设计稿', 'https://www.figma.com/file/abc123/TabNest-1-2', 'chrome::Default'],
  ['Linear – TAB-214 窗口状态恢复', 'https://linear.app/tabnest/issue/TAB-214', 'chrome::Default'],
  ['Stack Overflow: Electron frameless window drag region', 'https://stackoverflow.com/questions/35876939', 'chrome::Default'],
  ['Chromium SNSS 会话格式说明', 'https://chromium.googlesource.com/chromium/src/+/main/components/sessions/', 'vivaldi::Default'],
  ['Vivaldi 论坛 · 标签堆叠技巧', 'https://forum.vivaldi.net/topic/tab-stacks', 'vivaldi::Default'],
  ['京东 - 机械键盘 87 键', 'https://item.jd.com/100012043978.html', 'edge::Default'],
  ['淘宝 - 显示器支架', 'https://item.taobao.com/item.htm?id=6587412369', 'edge::Default'],
  ['豆瓣读书 - 设计心理学', 'https://book.douban.com/subject/26742402/', 'firefox::default-release'],
  ['微信读书 - 软件设计的哲学', 'https://weread.qq.com/web/bookDetail/a1b2c3', 'edge::Default'],
  ['Google 翻译', 'https://translate.google.com/', 'chrome::Default'],
  ['ChatGPT', 'https://chatgpt.com/', 'chrome::Default'],
  ['Microsoft Learn: Windows 11 app design', 'https://learn.microsoft.com/windows/apps/design/', 'edge::Default'],
  ['GitHub Actions: electron-builder 发布', 'https://github.com/tabnest/tabnest/actions/runs/11223344', 'chrome::Default'],
  ['npm: lucide-react', 'https://www.npmjs.com/package/lucide-react', 'chrome::Default'],
  ['Can I use: backdrop-filter', 'https://caniuse.com/css-backdrop-filter', 'firefox::default-release'],
  ['掘金 - 前端工程化实践', 'https://juejin.cn/post/7301234567890', 'edge::Default'],
  ['语雀 - 团队周报 第 42 周', 'https://www.yuque.com/tabnest/weekly/w42', 'edge::Default'],
  ['飞书文档 - 用户访谈纪要', 'https://tabnest.feishu.cn/docx/AbCdEf', 'edge::Default'],
  ['Cloudflare Dashboard', 'https://dash.cloudflare.com/', 'chrome::Default'],
  ['YouTube - Windows 11 Fluent Design deep dive', 'https://www.youtube.com/watch?v=Fl2ntD3s1gn', 'chrome::Default'],
  ['Wikipedia: Session management', 'https://en.wikipedia.org/wiki/Session_(computer_science)', 'firefox::default-release']
]

const fav = (domain: string) => {
  const hue = [...domain].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  const letter = domain.replace(/^www\./, '')[0].toUpperCase()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="hsl(${hue},55%,45%)"/><text x="8" y="12" font-size="10" font-family="Segoe UI,Arial" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const now = new Date()
for (let d = 6; d >= 0; d--) {
  const day = new Date(now)
  day.setDate(now.getDate() - d)
  // 2–3 captures per day; each sees a sliding window of tabs
  for (const h of [9, 14, 21]) {
    const at = new Date(day)
    at.setHours(h, 7 + d * 3, 0, 0)
    if (at > now) continue
    const start = (6 - d) * 4
    const pick = T.slice(start % 12, Math.min(T.length, 18 + start + (h === 21 ? 4 : 0)))
    repo.recordCapture(
      pick.map(([title, url, source]) => ({ title, url, source, browserId: source.split('::')[0], profileId: source.split('::')[1] })),
      at
    )
  }
}

const tabs = repo.snapshot().tabs
const byUrl = (u: string) => tabs.find((t) => t.url === u)!
const col = (n: string) => repo.findCollectionByName(n)!.id
const front = repo.createCollection('前端', '', col('学习'))
const design = repo.createCollection('设计规范', '', col('工作'))
repo.moveToCollection(
  ['https://zh-hans.react.dev/learn', 'https://cn.vitejs.dev/guide/', 'https://tanstack.com/virtual/latest'].map((u) => byUrl(u).id),
  front
)
repo.moveToCollection(
  ['https://fluent2.microsoft.design/', 'https://learn.microsoft.com/windows/apps/design/style/mica'].map((u) => byUrl(u).id),
  design
)
repo.moveToCollection([byUrl('https://www.zhihu.com/question/31846279').id, byUrl('https://book.douban.com/subject/26742402/').id], col('稍后阅读'))
for (const t of tabs) repo.db.prepare('UPDATE tabs SET favicon = ? WHERE id = ?').run(fav(t.domain), t.id)
const checked = new Date().toISOString()
tabs.forEach((t, i) => {
  if (i % 3 === 0) repo.setLinkStatus(t.id, { status: 'ok', statusCode: 200, checkedAt: checked })
  else if (i % 11 === 5) repo.setLinkStatus(t.id, { status: 'broken', statusCode: 404, note: 'Not Found', checkedAt: checked })
  else if (i % 13 === 7) repo.setLinkStatus(t.id, { status: 'redirect', statusCode: 301, checkedAt: checked })
})
const gh = byUrl('https://github.com/electron/electron')
repo.setSummary(gh.id, 'Electron 是使用 JavaScript、HTML 和 CSS 构建跨平台桌面应用的框架，基于 Chromium 与 Node.js。', [
  'Electron',
  '桌面应用',
  'Chromium',
  'Node.js'
])
repo.updateTab(gh.id, { note: '对照 33.x 的 BrowserWindow backgroundMaterial 选项。' })
repo.close()
console.log('screenshot data ready:', dir, tabs.length, 'tabs')
