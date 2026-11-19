import { siteOf } from '../cluster'

/**
 * Folder naming: short, Chinese-first, meaningful. Raw tokens like "grok" / "products" / "github.com"
 * are mapped to concepts ("AI 工具", "GitHub") or rejected.
 */

/** token / site → concept label (lowercase keys). */
const CONCEPT: [RegExp, string][] = [
  [
    /^(gpt|chatgpt|openai|claude|anthropic|gemini|grok|xai|llm|llama|kimi|moonshot|deepseek|qwen|tongyi|doubao|ernie|yiyan|glm|chatglm|zhipu|copilot|perplexity|poe|mistral|ollama|huggingface|ai|aigc|大模型|人工智能|智能体|agent|agents|prompt|提示词|rag)$/,
    'AI 工具'
  ],
  [/^(midjourney|stable|diffusion|sd|comfyui|dalle|文生图|绘图|flux|runway|sora|pika|kling|可灵)$/, 'AI 绘图'],
  [
    /^(shopify|amazon|ebay|etsy|aliexpress|temu|shein|lazada|shopee|tiktokshop|跨境电商|电商|选品|卖家|运营|店铺|seller|dropshipping|独立站|1688|淘宝|天猫|拼多多|京东|抖店|直播带货)$/,
    '电商运营'
  ],
  [/^(seo|sem|marketing|营销|推广|广告|ads|流量|私域|增长|growth|kol|网红|种草)$/, '营销推广'],
  [/^(react|vue|svelte|angular|nextjs|next|nuxt|vite|webpack|tailwind|css|html|javascript|js|typescript|ts|前端|frontend|组件)$/, '前端开发'],
  [/^(node|nodejs|python|java|golang|go|rust|php|ruby|spring|django|flask|fastapi|后端|backend|服务器)$/, '后端开发'],
  [/^(docker|kubernetes|k8s|devops|linux|nginx|运维|部署|aws|azure|gcp|云服务|阿里云|腾讯云|serverless)$/, '云与运维'],
  [/^(sql|mysql|postgres|postgresql|sqlite|redis|mongodb|数据库|database)$/, '数据库'],
  [/^(github|gitlab|gitee|git|开源|仓库|repo|repository)$/, '代码仓库'],
  [/^(bookmark|bookmarks|书签|收藏夹|tab|tabs|标签页|startpage|起始页|导航)$/, '书签管理'],
  [/^(notion|obsidian|logseq|evernote|onenote|笔记|note|notes|知识库|wiki|语雀|yuque)$/, '笔记知识库'],
  [/^(figma|sketch|dribbble|behance|设计|design|ui|ux|配色|字体|font|fonts|icon|icons|图标|素材|插画)$/, '设计素材'],
  [/^(video|youtube|bilibili|b站|视频|直播|抖音|douyin|tiktok)$/, '视频'],
  [/^(music|spotify|音乐|歌单|播客|podcast)$/, '音乐播客'],
  [/^(paper|papers|arxiv|论文|学术|期刊|research)$/, '论文'],
  [/^(course|courses|课程|教程|tutorial|tutorials|learn|学习|入门|mooc)$/, '课程教程'],
  [/^(leetcode|算法|algorithm|面试|interview)$/, '算法面试'],
  [/^(stock|stocks|股票|基金|fund|理财|投资|invest|crypto|bitcoin|比特币|加密货币|行情)$/, '投资理财'],
  [/^(news|新闻|资讯|快讯|日报)$/, '新闻资讯'],
  [/^(travel|旅行|旅游|酒店|hotel|机票|flight|攻略|景点)$/, '旅行出行'],
  [/^(recipe|菜谱|美食|food|外卖|餐厅)$/, '美食'],
  [/^(game|games|游戏|steam|手游|电竞)$/, '游戏'],
  [/^(job|jobs|招聘|求职|简历|resume|career|职场)$/, '求职招聘'],
  [/^(翻译|translate|translator|词典|dictionary)$/, '翻译词典'],
  [/^(pdf|转换|converter|压缩|截图|在线工具|tool|utility|utilities)$/, '在线工具'],
  [/^(mail|email|gmail|邮箱|outlook|网盘|drive|dropbox|onedrive)$/, '邮箱网盘'],
  [/^(shop|shopping|购物|商品|优惠|优惠券|deal|deals|折扣|价格)$/, '购物'],
  [/^(english|英语|雅思|托福|ielts|toefl|单词)$/, '英语学习'],
  [/^(health|健康|医疗|健身|fitness|减肥)$/, '健康健身']
]

/** Friendly names for popular sites (used when a group is "all from one site"). */
const SITE_NAME: Record<string, string> = {
  'github.com': 'GitHub',
  'bilibili.com': 'B站',
  'zhihu.com': '知乎',
  'youtube.com': 'YouTube',
  'juejin.cn': '掘金',
  'csdn.net': 'CSDN',
  'stackoverflow.com': 'Stack Overflow',
  'taobao.com': '淘宝',
  'tmall.com': '天猫',
  'jd.com': '京东',
  'douban.com': '豆瓣',
  'xiaohongshu.com': '小红书',
  'weibo.com': '微博',
  'twitter.com': 'X (Twitter)',
  'x.com': 'X (Twitter)',
  'reddit.com': 'Reddit',
  'medium.com': 'Medium',
  'notion.so': 'Notion',
  'feishu.cn': '飞书',
  'yuque.com': '语雀',
  'qq.com': '腾讯',
  'baidu.com': '百度',
  'sspai.com': '少数派',
  '36kr.com': '36氪',
  'v2ex.com': 'V2EX',
  'amazon.com': 'Amazon',
  'mozilla.org': 'MDN',
  'microsoft.com': '微软',
  'apple.com': 'Apple',
  'google.com': 'Google',
  'openai.com': 'OpenAI',
  'huggingface.co': 'Hugging Face',
  'arxiv.org': 'arXiv',
  'wikipedia.org': '维基百科',
  'douyin.com': '抖音',
  'figma.com': 'Figma',
  'npmjs.com': 'npm',
  'aliyun.com': '阿里云',
  'cnblogs.com': '博客园',
  'gitee.com': 'Gitee',
  'leetcode.cn': '力扣',
  'leetcode.com': 'LeetCode',
  'x.ai': 'xAI',
  'grok.com': 'Grok',
  'smzdm.com': '什么值得买',
  'pinduoduo.com': '拼多多',
  '1688.com': '1688'
}

const GENERIC =
  /^(products?|services?|tools?|pages?|home|index|docs?|blog|posts?|news|app|apps|web|site|official|官网|官方|首页|主页|网站|网页|页面|工具|产品|服务|平台|链接|内容|文章|其他|其它|misc|stuff|new|best|top|free|online|www|com|cn|net|org|io|html|search|login|en|zh)$/i

export function conceptOf(token: string): string | null {
  const t = token.toLowerCase().trim().replace(/\s+/g, '')
  for (const [re, name] of CONCEPT) if (re.test(t)) return name
  return null
}

export function friendlySite(site: string): string {
  const s = siteOf(site)
  if (SITE_NAME[s]) return SITE_NAME[s]
  const base = s.split('.')[0]
  return base.length <= 2 ? s : base[0].toUpperCase() + base.slice(1)
}

const isAsciiToken = (s: string) => /^[a-z0-9][a-z0-9+#.\-_]*$/.test(s)
const isDomainLike = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)

/** A folder name a human would not choose: raw lowercase token, domain, generic word, numeric. */
export function isVagueName(name: string): boolean {
  const n = name.trim()
  if (!n) return true
  if (GENERIC.test(n) || /^\d+$/.test(n)) return true
  if (isDomainLike(n)) return true
  if (isAsciiToken(n)) return true // raw lowercase tokens: "grok", "products", "react" (brands are Capitalized)
  return false
}

function shorten(name: string): string {
  const cjk = (name.match(/[\u4e00-\u9fff]/g) ?? []).length
  return cjk ? [...name].slice(0, 8).join('') : name.slice(0, 18)
}

/**
 * Name a group of items. Inputs, best first: candidate terms (topics/keywords/TF-IDF tokens), dominant category,
 * dominant site (share). Returns a short Chinese-first name, or null when nothing meaningful is available.
 */
export function nameFolder(input: { terms: string[]; category?: string | null; site?: { site: string; share: number } | null }): string | null {
  // 1) taxonomy category leaf (dominant category of the items; e.g. 开发/文档 → 文档, 视频)
  if (input.category) return shorten(input.category.split('/').at(-1)!)
  // 2) a single site dominating → its friendly name
  if (input.site && input.site.share >= 0.8) return friendlySite(input.site.site)
  // 3) concept votes from terms ("grok" / "chatgpt" → AI 工具, "shopify" → 电商运营)
  const votes = new Map<string, number>()
  input.terms.forEach((t, i) => {
    const c = conceptOf(t)
    if (c) votes.set(c, (votes.get(c) ?? 0) + (input.terms.length - i))
  })
  const best = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (best) return best
  // 4) a meaningful Chinese term, or a Capitalized brand-like latin term
  const zh = input.terms.find((t) => /[\u4e00-\u9fff]{2,}/.test(t) && !GENERIC.test(t))
  if (zh) return shorten(zh)
  const brand = input.terms.find((t) => /^[A-Z][A-Za-z0-9+#.]{2,}$/.test(t) && !GENERIC.test(t))
  if (brand) return shorten(brand)
  return null
}
