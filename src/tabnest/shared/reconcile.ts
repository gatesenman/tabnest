/** Per-browser count reconciliation: explain every gap between "what you see in the browser" and "what TabNest saved". */
export interface ReconcileInput {
  browserId: string
  name: string
  running: boolean
  locked: boolean
  stale: boolean
  /** mtime of the session file we actually read (ISO) */
  archiveAt: string | null
  /** tabs read from the session file before filtering */
  rawTabs: number
  /** browser-internal pages dropped (new tab, about:blank…) */
  filtered: number
  /** after cross-window / cross-profile URL de-dupe */
  deduped: number
  /** items from this browser in today's daily snapshot */
  inToday: number
}

export type FixAction = 'closeThis' | 'snapshotNow'

export interface Reconciliation extends ReconcileInput {
  /** the number we consider authoritative right now */
  best: number
  source: 'archive' | 'none'
  freshness: 'fresh' | 'old' | 'none'
  reasons: string[]
  fixes: FixAction[]
}

const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function reconcile(i: ReconcileInput, now = Date.now()): Reconciliation {
  const reasons: string[] = []
  const fixes = new Set<FixAction>()
  const ageMin = i.archiveAt ? (now - Date.parse(i.archiveAt)) / 60000 : Infinity
  const freshness: Reconciliation['freshness'] = !i.archiveAt && !i.rawTabs ? 'none' : ageMin <= 30 && !i.stale ? 'fresh' : 'old'
  const best = i.deduped
  if (i.locked && i.running) {
    reasons.push(
      `${i.name} 正在运行并独占锁定了当前会话文件，只能读取较旧的存档${i.archiveAt ? `（${hhmm(i.archiveAt)}）` : ''}，之后新开/关闭的标签不会体现。推荐「只快照并关闭此浏览器」：关闭后浏览器会写出最新会话，TabNest 再读取。`
    )
    fixes.add('closeThis')
  } else if (i.stale) {
    reasons.push(
      `读取的是较旧的会话存档${i.archiveAt ? `（${hhmm(i.archiveAt)}）` : ''}，可能与浏览器当前不一致。Edge / Vivaldi / QQ 等锁定时，请用「只快照并关闭此浏览器」。`
    )
    fixes.add('closeThis')
  } else if (freshness === 'old' && i.running) {
    reasons.push(`会话存档已有 ${Math.round(ageMin)} 分钟未更新。`)
  }
  if (i.filtered > 0) reasons.push(`过滤了 ${i.filtered} 个新标签页/浏览器内部页（不是网页，不保存）。`)
  const dup = i.rawTabs - i.filtered - i.deduped
  if (dup > 0) reasons.push(`${dup} 个是重复网址（多个窗口/配置里打开了同一页），只保存一份。`)
  if (best > 0 && i.inToday < best) {
    reasons.push(`今日快照里有 ${i.inToday} 个，还有 ${best - i.inToday} 个尚未快照。`)
    fixes.add('snapshotNow')
  } else if (i.inToday > best) reasons.push(`今日快照累计 ${i.inToday} 个：快照按天合并，包含今天早些时候打开、现在已关闭的标签。`)
  if (!reasons.length) reasons.push(best ? '数字一致，无需处理。' : '没有打开的网页。')
  return { ...i, best, source: i.rawTabs ? 'archive' : 'none', freshness, reasons, fixes: [...fixes] }
}
