import type { CloseResult } from './close'

/**
 * Pure orchestration for "snapshot & close all browsers" (deps injected → unit-testable).
 *
 * Edge/Vivaldi/QQ keep the *current* Session_* file under an exclusive lock while running, so nothing can
 * read it. For such a browser the only safe order is:
 *   close gracefully (WM_CLOSE → browser flushes its session) → wait for exit → read the now-unlocked file.
 * Prefer 「只快照并关闭此浏览器」 for a single locked browser rather than closing everything.
 */
export type Strategy = 'snapshot-then-close' | 'close-then-read'

export interface FlowBrowser {
  id: string
  name: string
  running: boolean
  /** newest session file unreadable */
  locked: boolean
  profileKeys: string[]
}

export function strategyFor(b: FlowBrowser): Strategy {
  if (b.locked && b.running) return 'close-then-read'
  return 'snapshot-then-close'
}

export interface FlowDeps {
  /** snapshot the given profiles; returns captured tab count per browser id */
  snapshot: (profileKeys: string[], browserIds: string[]) => Record<string, number> | Promise<Record<string, number>>
  close: (ids: string[]) => Promise<CloseResult[]>
  /** called between steps — lets tests assert ordering */
  log?: (event: string) => void
}

export interface FlowResult {
  captured: Record<string, number>
  closed: CloseResult[]
  skipped: { id: string; reason: string }[]
  /** closed, but the session file still could not be read: user can use the browser's own "restore" */
  unread: { id: string; name: string }[]
}

export async function runCloseFlow(browsers: FlowBrowser[], deps: FlowDeps, opts: { forceEvenIfEmpty?: boolean } = {}): Promise<FlowResult> {
  const log = deps.log ?? (() => undefined)
  const res: FlowResult = { captured: {}, closed: [], skipped: [], unread: [] }
  const first = browsers.filter((b) => strategyFor(b) !== 'close-then-read')
  const later = browsers.filter((b) => strategyFor(b) === 'close-then-read')

  // Phase A: readable browsers → snapshot first, verify, then close.
  if (first.length) {
    log(`snapshot:${first.map((b) => b.id).join(',')}`)
    const counts = await Promise.resolve(
      deps.snapshot(
        first.flatMap((b) => b.profileKeys),
        first.map((b) => b.id)
      )
    )
    const toClose: string[] = []
    for (const b of first) {
      const n = counts[b.id] ?? 0
      res.captured[b.id] = n
      if (n === 0 && b.running && !opts.forceEvenIfEmpty) res.skipped.push({ id: b.id, reason: `${b.name} 正在运行但快照没读到标签，已跳过关闭以免丢数据` })
      else toClose.push(b.id)
    }
    if (toClose.length) {
      log(`close:${toClose.join(',')}`)
      res.closed.push(...(await deps.close(toClose)))
    }
  }

  // Phase B: locked browsers → close first (graceful), then read the flushed session file.
  for (const b of later) {
    log(`close:${b.id}`)
    const [c] = await deps.close([b.id])
    if (c) res.closed.push(c)
    if (!c?.closed) {
      res.skipped.push({ id: b.id, reason: `${b.name} 未能关闭，也就无法读取它锁定的会话文件` })
      continue
    }
    log(`snapshot:${b.id}`)
    const n = (await Promise.resolve(deps.snapshot(b.profileKeys, [b.id])))[b.id] ?? 0
    res.captured[b.id] = n
    if (n === 0) res.unread.push({ id: b.id, name: b.name })
  }
  return res
}
