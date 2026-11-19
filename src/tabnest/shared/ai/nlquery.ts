import { segment } from './segment'

/** Parsed natural-language search query: structured filters + remaining free-text terms. */
export interface NlQuery {
  terms: string[]
  /** cross-language synonyms of the terms (书签 → bookmark), ranked with lower weight */
  expansions: string[]
  text: string
  from?: string // ISO, inclusive
  to?: string // ISO, exclusive
  browser?: string // browser id
  folder?: string // collection id
  site?: string
  status?: 'dead' | 'unsorted' | 'organized' | 'pinned' | 'noted'
  question: boolean
  chips: { kind: 'time' | 'browser' | 'folder' | 'site' | 'status'; label: string }[]
}

export interface NlContext {
  now?: Date
  browsers?: { id: string; name: string }[]
  folders?: { id: string; name: string }[]
}

const BROWSER_ALIASES: [RegExp, string, string][] = [
  [/(microsoft\s*edge|\bedge\b)/i, 'edge', 'Edge'],
  [/(google\s*chrome|\bchrome\b|谷歌浏览器)/i, 'chrome', 'Chrome'],
  [/(firefox|火狐)/i, 'firefox', 'Firefox'],
  [/(opera)/i, 'opera', 'Opera'],
  [/(brave)/i, 'brave', 'Brave'],
  [/(vivaldi)/i, 'vivaldi', 'Vivaldi'],
  [/(360\s*(安全|极速)?浏览器|\b360\b)/i, '360', '360 浏览器'],
  [/(qq\s*浏览器)/i, 'qqbrowser', 'QQ 浏览器'],
  [/(搜狗浏览器)/i, 'sogou', '搜狗浏览器'],
  [/(\barc\b)/i, 'arc', 'Arc'],
  [/(yandex)/i, 'yandex', 'Yandex']
]

const SITE_ALIASES: [RegExp, string][] = [
  [/(github)/i, 'github.com'],
  [/(b站|哔哩哔哩|bilibili)/i, 'bilibili.com'],
  [/(知乎)/i, 'zhihu.com'],
  [/(youtube|油管)/i, 'youtube.com'],
  [/(掘金)/i, 'juejin.cn'],
  [/(csdn)/i, 'csdn.net'],
  [/(小红书)/i, 'xiaohongshu.com'],
  [/(微博)/i, 'weibo.com'],
  [/(豆瓣)/i, 'douban.com'],
  [/(淘宝)/i, 'taobao.com'],
  [/(京东)/i, 'jd.com'],
  [/(stack\s*overflow)/i, 'stackoverflow.com'],
  [/(推特|twitter)/i, 'x.com'],
  [/(reddit)/i, 'reddit.com']
]

/** Bilingual synonyms so a Chinese query finds English pages and vice versa (no embeddings needed). */
const SYN_PAIRS: [string, string[]][] = [
  ['书签', ['bookmark']],
  ['收藏夹', ['bookmark', '书签']],
  ['标签页', ['tab', 'tabs']],
  ['工具', ['tool']],
  ['管理', ['manager']],
  ['视频', ['video']],
  ['文档', ['docs', 'documentation']],
  ['教程', ['tutorial', 'guide']],
  ['电商', ['ecommerce', 'shop']],
  ['购物', ['shop', 'buy']],
  ['大模型', ['llm', 'gpt']],
  ['人工智能', ['ai']],
  ['设计', ['design']],
  ['论文', ['paper', 'arxiv']],
  ['新闻', ['news']],
  ['音乐', ['music']],
  ['游戏', ['game']],
  ['笔记', ['note', 'notes']],
  ['翻译', ['translate', 'translator']],
  ['图片', ['image', 'photo']],
  ['字体', ['font']],
  ['图标', ['icon']],
  ['股票', ['stock']],
  ['基金', ['fund']],
  ['旅行', ['travel', 'trip']],
  ['菜谱', ['recipe']],
  ['招聘', ['job', 'jobs']],
  ['前端', ['frontend', 'react', 'vue']],
  ['后端', ['backend']],
  ['数据库', ['database', 'sql']],
  ['部署', ['deploy']],
  ['开源', ['github', 'open source']],
  ['课程', ['course']],
  ['邮箱', ['mail', 'email']],
  ['网盘', ['drive', 'cloud storage']],
  ['密码', ['password']],
  ['日历', ['calendar']],
  ['地图', ['map', 'maps']]
]
const SYN = (() => {
  const m = new Map<string, string[]>()
  for (const [zh, en] of SYN_PAIRS) {
    m.set(zh, [...(m.get(zh) ?? []), ...en])
    for (const e of en) m.set(e, [...(m.get(e) ?? []), zh])
  }
  return m
})()

const pad = (n: number) => String(n).padStart(2, '0')
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const md = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`
const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : (CN_NUM[s] ?? NaN))

/** Words that carry no search meaning in a question ("我收藏过哪些…的工具"). */
const FILLER =
  /(帮我|帮忙|请|给我|我的|我们|我|找一下|找找|找到|查找|搜索|搜一下|搜|查一下|有没有|有哪些|哪些|哪个|什么|是否|一下|之前|以前|曾经|收藏过|收藏了|保存过|保存了|打开过|打开的|看过的|看过|浏览过|访问过|用过|的|了|吗|呢|吧|相关的|相关|有关|关于|里面|里的|上的|中的|上面|网站|网页|页面|链接|内容|东西|资料|所有|全部|看的|在|看)/g

function parseTime(q: string, now: Date): { from: Date; to: Date; label: string; match: string } | null {
  const today = startOfDay(now)
  const rules: [RegExp, (m: RegExpExecArray) => { from: Date; to: Date; label: string } | null][] = [
    [/(今天|今日|today)/i, () => ({ from: today, to: addDays(today, 1), label: '今天' })],
    [/(昨天|昨日|yesterday)/i, () => ({ from: addDays(today, -1), to: today, label: '昨天' })],
    [/(前天)/, () => ({ from: addDays(today, -2), to: addDays(today, -1), label: '前天' })],
    [
      /(上上周)/,
      () => {
        const mon = addDays(today, -((today.getDay() + 6) % 7))
        return { from: addDays(mon, -14), to: addDays(mon, -7), label: '上上周' }
      }
    ],
    [
      /(上周|上个星期|上星期|上礼拜|last week)/i,
      () => {
        const mon = addDays(today, -((today.getDay() + 6) % 7))
        return { from: addDays(mon, -7), to: mon, label: '上周' }
      }
    ],
    [
      /(本周|这周|这个星期|这星期|this week)/i,
      () => {
        const mon = addDays(today, -((today.getDay() + 6) % 7))
        return { from: mon, to: addDays(today, 1), label: '本周' }
      }
    ],
    [
      /(上个月|上月|last month)/i,
      () => ({ from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1), label: '上个月' })
    ],
    [/(本月|这个月|this month)/i, () => ({ from: new Date(today.getFullYear(), today.getMonth(), 1), to: addDays(today, 1), label: '本月' })],
    [/(今年|this year)/i, () => ({ from: new Date(today.getFullYear(), 0, 1), to: addDays(today, 1), label: '今年' })],
    [/(去年|last year)/i, () => ({ from: new Date(today.getFullYear() - 1, 0, 1), to: new Date(today.getFullYear(), 0, 1), label: '去年' })],
    [
      /(?:最近|近|过去)\s*(\d+|[一两二三四五六七八九十])\s*(天|日|周|个?星期|个?月)/,
      (m) => {
        const n = num(m[1])
        if (!n) return null
        const days = /周|星期/.test(m[2]) ? n * 7 : /月/.test(m[2]) ? n * 30 : n
        return { from: addDays(today, -days + 1), to: addDays(today, 1), label: `近 ${n} ${m[2].replace('个', '')}` }
      }
    ],
    [
      /(\d+|[一两二三四五六七八九十])\s*天前/,
      (m) => {
        const n = num(m[1])
        return n ? { from: addDays(today, -n), to: addDays(today, -n + 1), label: `${n} 天前` } : null
      }
    ],
    [
      /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/,
      (m) => {
        const d = new Date(+m[1], +m[2] - 1, +m[3])
        return isNaN(+d) ? null : { from: d, to: addDays(d, 1), label: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` }
      }
    ],
    [
      /(\d{1,2})月(\d{1,2})[日号]/,
      (m) => {
        let d = new Date(today.getFullYear(), +m[1] - 1, +m[2])
        if (d > today) d = new Date(today.getFullYear() - 1, +m[1] - 1, +m[2])
        return { from: d, to: addDays(d, 1), label: md(d) }
      }
    ],
    [
      /(\d{1,2})月份?(?![\d日号])/,
      (m) => {
        const mo = +m[1] - 1
        if (mo < 0 || mo > 11) return null
        const y = mo > today.getMonth() ? today.getFullYear() - 1 : today.getFullYear()
        return { from: new Date(y, mo, 1), to: new Date(y, mo + 1, 1), label: `${y === today.getFullYear() ? '' : y + '年'}${mo + 1}月` }
      }
    ]
  ]
  for (const [re, f] of rules) {
    const m = re.exec(q)
    if (!m) continue
    const r = f(m)
    if (r) return { ...r, match: m[0] }
  }
  return null
}

export function parseNlQuery(input: string, ctx: NlContext = {}): NlQuery {
  const now = ctx.now ?? new Date()
  let q = input.trim()
  const chips: NlQuery['chips'] = []
  const out: NlQuery = {
    terms: [],
    expansions: [],
    text: '',
    question: /[?？]$|^(我|有没有|哪些|什么|怎么|如何|帮我|能不能|是否)|(吗|呢)[?？]?$/.test(q),
    chips
  }
  const cut = (s: string) => {
    q = q.replace(s, ' ')
  }
  const t = parseTime(q, now)
  if (t) {
    out.from = t.from.toISOString()
    out.to = t.to.toISOString()
    chips.push({ kind: 'time', label: t.label })
    cut(t.match)
  }
  const known = ctx.browsers
  for (const [re, id, name] of BROWSER_ALIASES) {
    const m = re.exec(q)
    if (!m) continue
    const b = known?.find((x) => x.id === id || x.id.startsWith(id) || x.name.toLowerCase().includes(id))
    out.browser = b?.id ?? id
    chips.push({ kind: 'browser', label: name })
    cut(m[0])
    q = q.replace(/(浏览器)?(里|中|上)?(打开|看)?(过)?的?/, (s) => (s.length ? ' ' : s))
    break
  }
  const sm = /site:([\w.-]+)/i.exec(q) ?? /\b((?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|ai|app|co|me|tv))\b/i.exec(q)
  if (sm) {
    out.site = sm[1].toLowerCase().replace(/^www\./, '')
    chips.push({ kind: 'site', label: out.site })
    cut(sm[0])
  } else
    for (const [re, site] of SITE_ALIASES) {
      const m = new RegExp(`${re.source}\\s*(上|里|中)的?`, 'i').exec(q) ?? (q.trim().length <= 8 ? re.exec(q) : null)
      if (m) {
        out.site = site
        chips.push({ kind: 'site', label: m[1] ?? site })
        cut(m[0])
        break
      }
    }
  // folder: 「X」收藏夹 / 在 X 里 / exact folder name mentioned
  const folders = [...(ctx.folders ?? [])].sort((a, b) => b.name.length - a.name.length)
  for (const f of folders) {
    if ([...f.name].length < 2) continue
    const re = new RegExp(`(在|放在|收藏夹)?[「“"]?${f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[」”"]?(收藏夹|文件夹|目录)?(里|中|下)?的?`)
    const m = re.exec(q)
    if (m && (m[1] || m[2] || m[3] || q.trim() === f.name)) {
      out.folder = f.id
      chips.push({ kind: 'folder', label: f.name })
      cut(m[0])
      break
    }
  }
  const status: [RegExp, NlQuery['status'], string][] = [
    [/(失效|死链|打不开|404|坏链|broken)/i, 'dead', '失效链接'],
    [/(未整理|未分类|没整理|没分类|待整理|unsorted)/i, 'unsorted', '未整理'],
    [/(已整理|已收藏|收藏夹里)/, 'organized', '已整理'],
    [/(置顶|固定的|pinned)/i, 'pinned', '固定标签'],
    [/(有备注|带备注|备注过)/, 'noted', '有备注']
  ]
  for (const [re, st, label] of status) {
    const m = re.exec(q)
    if (m) {
      out.status = st
      chips.push({ kind: 'status', label })
      cut(m[0])
      break
    }
  }
  const rest = q
    .replace(FILLER, ' ')
    .replace(/[\s,，。.;；、?？!！"'“”「」]+/g, ' ')
    .trim()
  out.text = rest
  const latin = rest.match(/[A-Za-z][A-Za-z0-9+#.]*/g) ?? []
  const segs = segment(rest)
  // compounds also match their parts (书签管理 → 书签 / 管理) so recall does not depend on exact wording
  const parts = segs.filter((x) => /^[\u4e00-\u9fff]{4}$/.test(x)).flatMap((x) => [x.slice(0, 2), x.slice(2)])
  out.terms = [
    ...new Set([...rest.split(' ').filter((x) => x && [...x].length <= 6), ...segs, ...parts, ...latin.map((x) => x.toLowerCase())].map((x) => x.toLowerCase()))
  ]
    .filter((x) => [...x].length >= 2)
    .slice(0, 16)
  const exp = new Set<string>()
  for (const t of out.terms) for (const x of SYN.get(t) ?? []) if (!out.terms.includes(x)) exp.add(x)
  out.expansions = [...exp].slice(0, 12)
  return out
}
