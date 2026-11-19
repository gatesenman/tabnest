/** Offline domain knowledge: ~300 popular CN/global sites → folder path. Keys are registrable sites (see siteOf). */
const T: Record<string, string> = {
  '开发/代码托管': 'github.com gitlab.com gitee.com bitbucket.org codeberg.org sourceforge.net coding.net',
  '开发/问答与社区':
    'stackoverflow.com stackexchange.com segmentfault.com v2ex.com juejin.cn csdn.net cnblogs.com oschina.net dev.to hashnode.com reddit.com/r/programming ruanyifeng.com infoq.cn',
  '开发/文档':
    'mozilla.org react.dev vuejs.org vitejs.dev nodejs.org python.org rust-lang.org go.dev typescriptlang.org electronjs.org docs.rs npmjs.com pypi.org kotlinlang.org swift.org learn.microsoft.com developer.apple.com developer.android.com tailwindcss.com nextjs.org svelte.dev angular.io deno.com bun.sh webpack.js.org sqlite.org postgresql.org mysql.com redis.io mongodb.com kubernetes.io docker.com tanstack.com playwright.dev vitest.dev',
  '开发/云与运维':
    'aws.amazon.com cloud.google.com azure.microsoft.com aliyun.com cloud.tencent.com huaweicloud.com vercel.com netlify.com cloudflare.com digitalocean.com heroku.com fly.io render.com supabase.com firebase.google.com',
  AI: 'openai.com chatgpt.com anthropic.com claude.ai gemini.google.com huggingface.co kimi.moonshot.cn moonshot.cn deepseek.com tongyi.aliyun.com yiyan.baidu.com doubao.com perplexity.ai midjourney.com stability.ai replicate.com ollama.com kaggle.com paperswithcode.com x.ai poe.com zhipuai.cn chatglm.cn',
  '学习/论文':
    'arxiv.org scholar.google.com researchgate.net semanticscholar.org cnki.net wanfangdata.com.cn nature.com sciencedirect.com springer.com ieee.org acm.org',
  '学习/课程':
    'coursera.org edx.org udemy.com khanacademy.org icourse163.org xuetangx.com geekbang.org imooc.com freecodecamp.org leetcode.com leetcode.cn codecademy.com duolingo.com',
  '学习/百科': 'wikipedia.org baike.baidu.com zhihu.com/question britannica.com',
  '资讯/科技':
    'ycombinator.com techcrunch.com theverge.com wired.com arstechnica.com 36kr.com ifanr.com sspai.com huxiu.com geekpark.net solidot.org engadget.com ithome.com cnbeta.com.cn',
  '资讯/新闻':
    'nytimes.com bbc.com bbc.co.uk cnn.com reuters.com apnews.com theguardian.com wsj.com ft.com bloomberg.com economist.com xinhuanet.com people.com.cn thepaper.cn sina.com.cn 163.com sohu.com qq.com ifeng.com caixin.com jiemian.com zaobao.com',
  社交: 'twitter.com x.com weibo.com facebook.com instagram.com linkedin.com threads.net mastodon.social douban.com xiaohongshu.com tieba.baidu.com telegram.org discord.com',
  视频: 'youtube.com bilibili.com youku.com iqiyi.com v.qq.com douyin.com ixigua.com netflix.com vimeo.com twitch.tv tiktok.com acfun.cn mgtv.com',
  音乐: 'music.163.com y.qq.com spotify.com music.apple.com soundcloud.com kugou.com kuwo.cn',
  阅读: 'medium.com substack.com weread.qq.com goodreads.com jianshu.com qidian.com douban.com/book kindle.amazon.com',
  购物: 'taobao.com tmall.com jd.com pinduoduo.com amazon.com amazon.cn ebay.com aliexpress.com smzdm.com suning.com vip.com dangdang.com 1688.com xianyu.com walmart.com bestbuy.com apple.com/shop',
  设计: 'figma.com dribbble.com behance.net canva.com pinterest.com unsplash.com pexels.com iconfont.cn zcool.com.cn huaban.com fonts.google.com coolors.co sketch.com framer.com',
  工作协作:
    'notion.so notion.site slack.com feishu.cn larksuite.com dingtalk.com trello.com asana.com linear.app atlassian.net atlassian.com jira.com confluence.com monday.com airtable.com yuque.com shimo.im docs.qq.com miro.com zoom.us teams.microsoft.com office.com',
  '工具/邮箱与网盘':
    'mail.google.com outlook.com outlook.live.com mail.qq.com mail.163.com drive.google.com dropbox.com onedrive.live.com pan.baidu.com aliyundrive.com alipan.com 115.com box.com icloud.com',
  '工具/在线工具':
    'translate.google.com deepl.com fanyi.baidu.com regex101.com jsonformatter.org tinypng.com remove.bg smallpdf.com ilovepdf.com speedtest.net whois.com caniuse.com excalidraw.com draw.io diagrams.net codepen.io codesandbox.io jsfiddle.net stackblitz.com',
  搜索: 'google.com bing.com baidu.com duckduckgo.com sogou.com so.com yandex.com',
  金融: 'xueqiu.com eastmoney.com 10jqka.com.cn investing.com tradingview.com finance.yahoo.com coinmarketcap.com binance.com okx.com futunn.com alipay.com paypal.com',
  '生活/地图与出行':
    'maps.google.com amap.com map.baidu.com ctrip.com trip.com booking.com airbnb.com qunar.com fliggy.com 12306.cn didiglobal.com tripadvisor.com',
  '生活/美食与本地': 'meituan.com dianping.com ele.me xiachufang.com',
  游戏: 'steampowered.com steamcommunity.com epicgames.com nintendo.com playstation.com xbox.com taptap.cn mihoyo.com 4399.com ign.com gamespot.com'
}

export interface SiteHint {
  folder: string
  /** pattern contained a path (more specific) */
  path?: string
}

export const SITE_TABLE: Map<string, SiteHint> = (() => {
  const m = new Map<string, SiteHint>()
  for (const [folder, list] of Object.entries(T))
    for (const raw of list.split(/\s+/).filter(Boolean)) {
      const [host, ...p] = raw.split('/')
      const key = p.length ? `${host}/${p.join('/')}` : host
      m.set(key, { folder, path: p.length ? `/${p.join('/')}` : undefined })
    }
  return m
})()

export const SITE_COUNT = SITE_TABLE.size

/** Topic words → folder (title/path keywords), used when the domain is unknown. */
export const KEYWORD_HINTS: [RegExp, string][] = [
  [/\b(github|gitlab|gitee|repo|repository|pull request|commits?)\b|代码仓库|开源项目|源码/i, '开发/代码托管'],
  [
    /\b(api|sdk|docs?|documentation|reference|npm|typescript|javascript|python|rust|golang|react|vue|electron|kubernetes|docker|sql|css|html|node\.?js|webpack|vite|framework|library|cli)\b|教程|文档|编程|开发者|前端|后端|接口|框架|组件库/i,
    '开发/文档'
  ],
  [/\b(stack ?overflow|how to fix|error|exception|bug)\b|报错|问答社区|技术社区|技术博客/i, '开发/问答与社区'],
  [/\b(cloud|serverless|hosting|deploy|cdn|devops|vps|kubernetes)\b|云服务|服务器|部署|运维|域名/i, '开发/云与运维'],
  [
    /\b(gpt|chatgpt|llm|ai|prompt|diffusion|transformer|agents?|rag|openai|claude|gemini|copilot|grok|deepseek|chatbot|embedding|fine-?tun\w*)\b|大模型|人工智能|机器学习|深度学习|智能体|提示词|生成式|AIGC|文生图/i,
    'AI'
  ],
  [/\b(paper|arxiv|thesis|journal|preprint|citation)\b|论文|期刊|学术|文献/i, '学习/论文'],
  [/\b(course|lecture|tutorial|learn|mooc|lesson|bootcamp)\b|课程|学习|入门|考试|考研|公开课|题库|网课/i, '学习/课程'],
  [/\b(wiki|encyclopedia)\b|百科|词条/i, '学习/百科'],
  [/\b(startup|tech news|gadget|review)\b|科技|数码|评测|互联网|创投/i, '资讯/科技'],
  [/\b(news|breaking|headline)\b|新闻|快讯|日报|时事|要闻/i, '资讯/新闻'],
  [/\b(video|watch|episode|movie|film|anime|stream)\b|视频|直播|番剧|电影|电视剧|动漫|综艺|纪录片/i, '视频'],
  [/\b(music|song|album|playlist|podcast)\b|音乐|歌曲|歌单|专辑|播客/i, '音乐'],
  [/\b(novel|ebook|kindle|reading|newsletter)\b|小说|电子书|阅读|书评|读书/i, '阅读'],
  [
    /\b(buy|price|deal|shop|cart|sku|coupon|store|discount|ecommerce|e-commerce|shopify|seller|amazon)\b|购买|价格|优惠|商品|京东|淘宝|天猫|拼多多|旗舰店|电商|选品|跨境|下单|包邮/i,
    '购物'
  ],
  [/\b(design|ui|ux|figma|icons?|fonts?|mockup|palette|illustration|wallpaper)\b|设计|配色|字体|图标|素材|插画|壁纸|原型/i, '设计'],
  [
    /\b(notion|kanban|todo|okr|wiki|workspace|meeting|calendar|crm|project management|collaborat\w*)\b|协作|待办|项目管理|会议|日程|办公|飞书|钉钉|看板/i,
    '工作协作'
  ],
  [/\b(mail|inbox|cloud drive|storage|backup)\b|邮箱|网盘|云盘|同步盘/i, '工具/邮箱与网盘'],
  [
    /\b(converter|convert|compress|translator|translate|regex|json|formatter|generator|calculator|online tool|pdf|bookmarks?|tab manager|extension)\b|在线工具|转换|压缩|翻译|格式化|生成器|计算器|书签|收藏夹|标签页管理|插件/i,
    '工具/在线工具'
  ],
  [/\b(stock|fund|crypto|bitcoin|invest\w*|trading|forex|etf)\b|股票|基金|理财|行情|投资|证券|加密货币|比特币/i, '金融'],
  [/\b(hotel|flight|travel|trip|map|booking)\b|酒店|机票|旅行|旅游|景点|地图|导航|火车票/i, '生活/地图与出行'],
  [/\b(recipe|restaurant|food|cooking)\b|菜谱|美食|外卖|餐厅|做法/i, '生活/美食与本地'],
  [/\b(game|steam|gaming|esports|rpg)\b|游戏|手游|电竞|主机游戏/i, '游戏'],
  [/\b(tweet|weibo|community|forum|social)\b|微博|社区|论坛|朋友圈|小红书|关注/i, '社交']
]
