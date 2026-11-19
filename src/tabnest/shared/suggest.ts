/** Domain → preferred built-in folder (quick-organize suggestions). */
const RULES: [string, string][] = [
  ['github.com', '工作'],
  ['gitlab', '工作'],
  ['notion.so', '工作'],
  ['feishu', '工作'],
  ['atlassian', '工作'],
  ['stackoverflow.com', '学习'],
  ['react.dev', '学习'],
  ['developer.mozilla.org', '学习'],
  ['juejin.cn', '学习'],
  ['electronjs.org', '学习'],
  ['vitejs.dev', '学习'],
  ['developer.chrome.com', '学习'],
  ['wikipedia.org', '学习'],
  ['weread.qq.com', '学习'],
  ['arxiv.org', '学习'],
  ['zhihu.com', '稍后阅读'],
  ['bilibili.com', '稍后阅读'],
  ['youtube.com', '稍后阅读'],
  ['xiaohongshu.com', '稍后阅读'],
  ['douban.com', '稍后阅读'],
  ['medium.com', '稍后阅读']
]

export function suggestFolderName(domain: string): string {
  const d = domain.toLowerCase()
  return RULES.find(([k]) => d === k || d.endsWith('.' + k) || d.includes(k))?.[1] ?? '未分类'
}
