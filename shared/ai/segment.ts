/**
 * Lightweight bilingual segmentation (pure TS, no deps):
 * - CJK runs: forward maximum matching against a compact domain dictionary; unmatched spans fall back to bigrams.
 * - Latin: words, camelCase / kebab split, light plural stemming.
 * Stopwords removed for both. Good enough for keyword extraction, FTS expansion and hashed vectors.
 */

/** Common multi-char Chinese words (tech, AI, shopping, study, media, life). Longest match wins. */
const DICT_WORDS = `
人工智能 机器学习 深度学习 大模型 大语言模型 神经网络 自然语言 自然语言处理 计算机视觉 提示词 智能体 知识库 向量数据库 生成式 文生图 语音识别 数据集 训练 推理 微调 开源
编程 程序员 开发者 前端 后端 全栈 框架 组件 源码 代码 仓库 文档 教程 入门 进阶 实战 指南 手册 示例 最佳实践 面试 算法 数据结构 数据库 服务器 云服务 容器 部署 运维 测试 调试 性能 优化 安全 漏洞 接口 插件 扩展 浏览器 操作系统 命令行 终端 编辑器 版本控制 配置 安装 下载 更新 发布 小程序 公众号 爬虫 脚本 自动化 低代码 工作流
书签 收藏夹 标签页 书签管理 状态管理 知识管理 内容管理 密码管理 时间管理 笔记 待办 效率 工具 生产力 管理 项目管理 协作 团队 文件 网盘 邮箱 日历 会议 翻译 词典 思维导图 白板 表格 文档协作 在线工具 格式转换 截图 录屏 压缩 密码
设计 配色 字体 图标 素材 插画 摄影 图片 壁纸 排版 原型 交互 用户体验 品牌 海报 模板
购物 商品 价格 优惠 优惠券 折扣 订单 购物车 店铺 旗舰店 电商 运营 跨境电商 选品 卖家 买家 物流 快递 二手 拼团 秒杀 直播带货 营销 推广 广告 流量 私域 种草 测评 开箱 评测
新闻 资讯 快讯 日报 周报 科技 财经 经济 股票 基金 理财 投资 加密货币 比特币 汇率 行情 保险 贷款 银行 信用卡 税务
视频 直播 电影 电视剧 综艺 动漫 番剧 纪录片 音乐 歌曲 歌单 播客 有声书 小说 漫画 阅读 电子书 书评 影评 豆瓣 游戏 攻略 手游 主机 电竞
学习 课程 考试 考研 留学 英语 雅思 托福 论文 期刊 学术 研究 文献 百科 知识 问答 讲座 公开课 题库 高考 大学 学校 教育
旅行 旅游 酒店 机票 火车票 地图 导航 景点 美食 菜谱 外卖 餐厅 健身 减肥 健康 医疗 医院 养生 育儿 母婴 家居 装修 汽车 宠物 天气 招聘 求职 简历 职场 租房 房产 政务 社保 公积金
社交 社区 论坛 博客 专栏 文章 微博 知乎 小红书 抖音 快手 哔哩哔哩 微信 朋友圈 话题 评论
官网 首页 登录 注册 账号 设置 帮助 下载中心 用户 个人中心 控制台 后台 仪表盘 产品 服务 解决方案 定价 价格方案
`
  .split(/\s+/)
  .filter(Boolean)

export const DICT = new Set(DICT_WORDS)
const MAX_WORD = Math.max(...DICT_WORDS.map((w) => w.length))

/** Function words / filler (CJK). */
const ZH_STOP = new Set(
  `的 了 和 与 及 或 是 在 我 你 他 她 它 们 我们 你们 这 那 这个 那个 一个 一些 有 没有 不 也 都 就 还 很 最 更 被 把 对 为 从 到 以 之 其 于 而 并 等 让 给 用 上 中 下 里 吗 呢 吧 啊 哦 个 种 些 么 什么 怎么 如何 为什么 哪些 哪个 可以 能 会 要 想 做 来 去 说 看 比 将 已 已经 正在 自己 所有 大家 关于 有关 以及 如果 因为 所以 但是 然而 通过 进行 使用 相关 更多 全部 其他 其它 今天 昨天 明天 欢迎 访问 网站 网页 页面 官方 首页 主页 点击 查看 链接 免费 最新 一下 一种 方面 内容 文章 本站 版权 所有 收藏过 打开过 看过 帮我 找 找一下 关于`.split(
    /\s+/
  )
)

const EN_STOP = new Set(
  `a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those you your we our they their he she his her i me my not no yes do does did done can could will would should may might must have has had what which who whom how why when where there here all any each more most some such only own same so than too very just also into over about after before between under again further once out up down off new get got use using used via vs per etc
  all one www com cn org net io dev app html htm php asp aspx jsp http https index page pages home homepage zh en us hans hant latest default welcome official site website web online free best top login signin sign register account amp nbsp quot`.split(
    /\s+/
  )
)

export function isStopword(w: string): boolean {
  const l = w.toLowerCase()
  return ZH_STOP.has(l) || EN_STOP.has(l)
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const isCjk = (ch: string) => CJK.test(ch)

/** Forward maximum matching over one CJK run; unknown stretches are emitted as overlapping bigrams. */
/** Head nouns that form compounds with a preceding unknown 2-char word (状态+管理 → 状态管理). */
const HEADS = new Set([
  '管理',
  '工具',
  '平台',
  '系统',
  '框架',
  '模型',
  '教程',
  '文档',
  '社区',
  '助手',
  '插件',
  '软件',
  '服务',
  '设计',
  '运营',
  '开发',
  '分析',
  '笔记',
  '资讯',
  '攻略'
])

function segmentCjk(run: string): string[] {
  const out: string[] = []
  let unknown = ''
  const flush = () => {
    const u = [...unknown].filter((c) => !ZH_STOP.has(c)).join('')
    if (u.length === 2 || u.length === 3) out.push(u)
    else if (u.length > 3) for (let i = 0; i + 2 <= u.length; i++) out.push(u.slice(i, i + 2))
    unknown = ''
  }
  let i = 0
  while (i < run.length) {
    let hit = ''
    for (let n = Math.min(MAX_WORD, run.length - i); n >= 2; n--) {
      const w = run.slice(i, i + n)
      if (DICT.has(w) || ZH_STOP.has(w)) {
        hit = w
        break
      }
    }
    if (hit) {
      const prev = [...unknown].filter((c) => !ZH_STOP.has(c)).join('')
      flush()
      if (prev.length === 2 && HEADS.has(hit)) out.push(prev + hit)
      if (!ZH_STOP.has(hit)) out.push(hit)
      i += hit.length
    } else {
      const c = run[i]
      if (ZH_STOP.has(c)) flush()
      else unknown += c
      i++
    }
  }
  flush()
  return out
}

function stem(w: string): string {
  if (/[.+#]/.test(w)) return w
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y'
  if (w.length > 4 && /[^s]s$/.test(w) && !/(ss|us|is|os)$/.test(w)) return w.slice(0, -1)
  return w
}

/** Split text into normalized tokens (lowercase latin, CJK words). Order preserved, duplicates kept. */
export function segment(text: string): string[] {
  const out: string[] = []
  const s = text.normalize('NFKC')
  // latin/number words incl. c++, c#, node.js
  const re = /([\u3400-\u9fff\uf900-\ufaff]+)|([A-Za-z][A-Za-z0-9]*(?:[+#]{1,2}|\.js)?|\d+[A-Za-z]+[A-Za-z0-9]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m[1]) {
      out.push(...segmentCjk(m[1]))
      continue
    }
    const raw = m[2]
    // camelCase / PascalCase split, keep whole word as well when it is a product-like name
    const parts = raw.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')
    for (const p of parts.length > 1 ? [raw, ...parts] : parts) {
      const w = p.toLowerCase()
      if (w.length < 2 || EN_STOP.has(w) || /^\d+$/.test(w) || /^[a-z0-9]{16,}$/.test(w)) continue
      if (/^[a-f0-9]{8,}$/.test(w) && /\d/.test(w)) continue // hashes / ids
      out.push(stem(w))
    }
  }
  return out
}

export interface WeightedText {
  text: string
  weight: number
}

/** Generic words that carry little meaning as keywords even if not stopwords. */
const LOW_INFO = new Set(
  `工具 网站 平台 服务 产品 系统 中心 信息 数据 用户 平台 页面 管理 世界 中国 全球 专业 领先 一站式 解决方案 product products service services tool tools platform solution solutions blog post news docs doc guide overview introduction intro start started getting learn more read about contact help support pricing feature features download`.split(
    /\s+/
  )
)

/**
 * Keyword extraction: weighted term frequency over fields (title > og/meta > headings > body),
 * damped for generic terms, bonus for dictionary words and multi-char CJK. Returns display forms.
 */
export function extractKeywords(fields: WeightedText[], k = 8): string[] {
  const score = new Map<string, number>()
  const display = new Map<string, string>()
  for (const f of fields) {
    if (!f.text) continue
    const toks = segment(f.text)
    const seen = new Set<string>()
    for (const t of toks) {
      const key = t.toLowerCase()
      let w = f.weight * (seen.has(key) ? 0.35 : 1)
      seen.add(key)
      if (isCjk(t[0])) w *= DICT.has(t) ? 1.6 : t.length >= 3 ? 1.1 : 0.7
      else w *= t.length >= 4 ? 1.1 : 0.8
      if (LOW_INFO.has(key)) w *= 0.25
      score.set(key, (score.get(key) ?? 0) + w)
      if (!display.has(key)) display.set(key, t)
    }
    // keep original casing for latin words from the title (React, GitHub…)
    for (const m of f.text.matchAll(/[A-Za-z][A-Za-z0-9+#.]{1,30}/g)) {
      const key = stem(m[0].toLowerCase().replace(/\.$/, ''))
      if (score.has(key) && display.get(key) === key && /[A-Z]/.test(m[0])) display.set(key, m[0].replace(/\.$/, ''))
    }
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1])
  const out: string[] = []
  for (const [key] of ranked) {
    // drop a bigram that is fully contained in an already chosen longer word
    if (out.some((o) => o.toLowerCase().includes(key) && o.length > key.length)) continue
    out.push(display.get(key) ?? key)
    if (out.length >= k) break
  }
  return out
}
