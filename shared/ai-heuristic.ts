const DOMAIN_HINTS: [string, string, string[]][] = [
  ['github.com', 'GitHub 上的代码仓库、议题或讨论', ['GitHub', '代码', '开源']],
  ['gitlab', 'GitLab 代码协作页面', ['GitLab', '代码']],
  ['stackoverflow.com', '技术问答与编程问题解答', ['编程', '问答']],
  ['zhihu.com', '知乎问答或专栏文章', ['知乎', '问答']],
  ['bilibili.com', '哔哩哔哩视频', ['B站', '视频']],
  ['youtube.com', 'YouTube 视频', ['YouTube', '视频']],
  ['juejin.cn', '掘金技术文章', ['掘金', '技术文章']],
  ['developer.mozilla.org', 'MDN Web 技术文档', ['MDN', 'Web', '文档']],
  ['react.dev', 'React 官方文档', ['React', '前端', '文档']],
  ['taobao.com', '淘宝购物页面', ['购物', '淘宝']],
  ['jd.com', '京东商品或搜索页', ['购物', '京东']],
  ['notion.so', 'Notion 笔记或工作区', ['笔记', 'Notion']],
  ['wikipedia.org', '维基百科词条', ['百科', '知识']],
  ['douban.com', '豆瓣书影音', ['豆瓣', '书影音']],
  ['music.163.com', '网易云音乐', ['音乐']],
  ['weread.qq.com', '微信读书', ['阅读', '电子书']],
  ['xiaohongshu.com', '小红书笔记', ['小红书', '生活']],
  ['electronjs.org', 'Electron 桌面开发文档', ['Electron', '桌面', '文档']],
  ['vitejs.dev', 'Vite 构建工具文档', ['Vite', '前端', '构建']],
  ['developer.chrome.com', 'Chrome 开发者文档', ['Chrome', '扩展', '文档']],
  ['arxiv.org', 'arXiv 学术论文', ['论文', '学术']],
  ['medium.com', 'Medium 博客文章', ['博客', '文章']]
]

const PATH_HINTS: [RegExp, string][] = [
  [/\/(docs?|guide|manual|reference|api)\b/i, '文档'],
  [/\/(blog|post|article|p)\b/i, '文章'],
  [/\/(issues?|pull|pulls)\b/i, '议题'],
  [/\/(video|watch)\b/i, '视频'],
  [/\/(search|s)\b|[?&](q|keyword|wd)=/i, '搜索'],
  [/\/(cart|item|product)\b/i, '商品']
]

const STOP = new Set([
  'www',
  'com',
  'cn',
  'org',
  'net',
  'io',
  'dev',
  'html',
  'htm',
  'php',
  'the',
  'and',
  'for',
  'http',
  'https',
  'index',
  'page',
  'home',
  'zh',
  'en',
  'latest'
])

export interface Summary {
  description: string
  keywords: string[]
}

export interface Enrichment extends Summary {
  topics: string[]
  summary: string
  lang: string
}

export function detectLang(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  if (/[a-z]{3,}/i.test(text)) return 'en'
  return ''
}

export function tokenize(title: string, url: string): string[] {
  const parts = title.split(/[\s\-_|·/\\:：,，.。、()（）[\]【】]+/)
  try {
    const u = new URL(url)
    parts.push(...u.pathname.split(/[/\-_.]+/))
  } catch {
    /* ignore */
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const t = p.replace(/[^a-zA-Z0-9\u4e00-\u9fff+#]/g, '')
    const low = t.toLowerCase()
    if (t.length < 2 || STOP.has(low) || /^\d+$/.test(t) || /^[a-z0-9]{12,}$/i.test(t) || seen.has(low)) continue
    seen.add(low)
    out.push(t.slice(0, 20))
  }
  return out
}

export function heuristicSummary(title: string, url: string, domain: string): Summary {
  const d = domain.toLowerCase()
  const hint = DOMAIN_HINTS.find(([k]) => d === k || d.endsWith('.' + k) || d.includes(k))
  const pathHint = PATH_HINTS.find(([re]) => re.test(url))?.[1]
  const tokens = tokenize(title, url)
  const keywords = [...new Set([...(hint?.[2] ?? []), ...(pathHint ? [pathHint] : []), ...tokens])].slice(0, 8)
  const shortTitle = title.trim().slice(0, 36)
  let description: string
  if (hint) description = shortTitle && shortTitle !== domain ? `${hint[1]}：${shortTitle}` : hint[1]
  else if (shortTitle && shortTitle !== domain) description = `来自 ${domain} 的${pathHint ?? '网页'}：${shortTitle}`
  else description = `来自 ${domain} 的${pathHint ?? '网页'}`
  return { description, keywords }
}

/** Offline enrichment: domain table + title/path heuristics → description, keywords, topics, one-line summary, language. */
export function heuristicEnrich(title: string, url: string, domain: string): Enrichment {
  const base = heuristicSummary(title, url, domain)
  const d = domain.toLowerCase()
  const hint = DOMAIN_HINTS.find(([k]) => d === k || d.endsWith('.' + k) || d.includes(k))
  const pathHint = PATH_HINTS.find(([re]) => re.test(url))?.[1]
  const topics = [...new Set([...(hint ? [hint[1]] : []), ...(pathHint ? [pathHint] : []), ...(hint?.[2] ?? []).slice(0, 2)])].slice(0, 5)
  const t = title.trim()
  const summary = (t && t !== domain ? `${t.slice(0, 60)}（${domain}）` : base.description).slice(0, 80)
  return { ...base, topics, summary, lang: detectLang(t) }
}
