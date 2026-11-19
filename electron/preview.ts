import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import log from 'electron-log/main'
import { canPreview } from '../shared/preview'

export const PREVIEW_TTL_DAYS = 30
export const PREVIEW_WIDTH = 480

export interface PreviewInfo {
  url: string
  status: 'ok' | 'failed' | 'pending' | 'none'
  capturedAt: string | null
  error: string | null
  bytes: number
}

/** Captures one url → JPEG bytes (already resized). Injected so tests don't need Electron. */
export type CaptureFn = (url: string) => Promise<Buffer>

export const urlHash = (url: string) => createHash('sha1').update(url).digest('hex').slice(0, 24)

type Row = Record<string, unknown>

/**
 * Preview screenshot cache: files under <userData>/previews/<hash>.jpg, index in table `previews`.
 * Background queue (1 worker by default), timeouts, failure backoff (1h → 6h → 1d → 7d), 30-day refresh.
 */
export class PreviewService {
  readonly dir: string
  private busy = 0
  private timer: NodeJS.Timeout | null = null
  private inflight = new Set<string>()

  constructor(
    private db: Database.Database,
    userData: string,
    private capture: CaptureFn,
    private opts: {
      enabled: () => boolean
      userActive?: () => boolean
      onChange?: () => void
      concurrency?: number
      now?: () => Date
    }
  ) {
    this.dir = join(userData, 'previews')
    mkdirSync(this.dir, { recursive: true })
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  fileOf(url: string): string {
    return join(this.dir, `${urlHash(url)}.jpg`)
  }

  /** Path of a cached thumbnail, or null. */
  pathFor(url: string): string | null {
    const r = this.db.prepare("SELECT path FROM previews WHERE url_hash = ? AND status = 'ok'").get(urlHash(url)) as Row | undefined
    const p = r ? join(this.dir, r.path as string) : null
    return p && existsSync(p) ? p : null
  }

  info(url: string): PreviewInfo {
    const r = this.db.prepare('SELECT * FROM previews WHERE url_hash = ?').get(urlHash(url)) as Row | undefined
    if (this.inflight.has(url)) return { url, status: 'pending', capturedAt: (r?.captured_at as string) ?? null, error: null, bytes: (r?.bytes as number) ?? 0 }
    if (!r) return { url, status: 'none', capturedAt: null, error: null, bytes: 0 }
    return {
      url,
      status: r.status as 'ok' | 'failed',
      capturedAt: (r.captured_at as string) ?? null,
      error: (r.error as string) ?? null,
      bytes: (r.bytes as number) ?? 0
    }
  }

  /** Urls due for capture: never captured, expired (>30 days), or failed with backoff elapsed. Live tabs first by recency. */
  due(limit: number): string[] {
    const now = this.now()
    const exp = new Date(now.getTime() - PREVIEW_TTL_DAYS * 86400000).toISOString()
    const rows = this.db
      .prepare(
        `SELECT t.url, MAX(t.created_at) ls FROM tabs t
         LEFT JOIN previews p ON p.url = t.url
         WHERE t.url LIKE 'http%' AND (p.url_hash IS NULL OR (p.status = 'ok' AND p.captured_at < ?) OR (p.status = 'failed' AND p.next_try <= ?))
         GROUP BY t.url ORDER BY ls DESC LIMIT ?`
      )
      .all(exp, now.toISOString(), limit * 3) as Row[]
    return rows
      .map((r) => r.url as string)
      .filter((u) => canPreview(u) && !this.inflight.has(u))
      .slice(0, limit)
  }

  /** Capture one url now (manual 刷新预览 or queue). Never throws. */
  async refresh(url: string): Promise<PreviewInfo> {
    if (!canPreview(url)) return { url, status: 'failed', capturedAt: null, error: '不支持的网址', bytes: 0 }
    if (this.inflight.has(url)) return this.info(url)
    this.inflight.add(url)
    const h = urlHash(url)
    const at = this.now().toISOString()
    try {
      const jpg = await this.capture(url)
      if (!jpg?.length) throw new Error('空白截图')
      const name = `${h}.jpg`
      writeFileSync(join(this.dir, name), jpg)
      this.db
        .prepare(
          `INSERT INTO previews (url_hash, url, path, captured_at, status, fails, next_try, error, bytes) VALUES (?, ?, ?, ?, 'ok', 0, NULL, NULL, ?)
           ON CONFLICT(url_hash) DO UPDATE SET path = excluded.path, captured_at = excluded.captured_at, status = 'ok', fails = 0, next_try = NULL, error = NULL, bytes = excluded.bytes`
        )
        .run(h, url, name, at, jpg.length)
    } catch (e) {
      const prev = this.db.prepare('SELECT fails FROM previews WHERE url_hash = ?').get(h) as Row | undefined
      const fails = ((prev?.fails as number) ?? 0) + 1
      const backoffH = [1, 6, 24, 168][Math.min(fails, 4) - 1]
      const next = new Date(this.now().getTime() + backoffH * 3600000).toISOString()
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 120)
      this.db
        .prepare(
          `INSERT INTO previews (url_hash, url, path, captured_at, status, fails, next_try, error, bytes) VALUES (?, ?, NULL, ?, 'failed', ?, ?, ?, 0)
           ON CONFLICT(url_hash) DO UPDATE SET status = CASE WHEN previews.path IS NOT NULL THEN 'ok' ELSE 'failed' END,
             fails = excluded.fails, next_try = excluded.next_try, error = excluded.error,
             captured_at = CASE WHEN previews.path IS NOT NULL THEN previews.captured_at ELSE excluded.captured_at END`
        )
        .run(h, url, at, fails, next, msg)
      // keep an older good thumbnail on refresh failure, but back off the refresh
      if (this.pathFor(url)) this.db.prepare('UPDATE previews SET next_try = ? WHERE url_hash = ?').run(next, h)
    } finally {
      this.inflight.delete(url)
      this.opts.onChange?.()
    }
    return this.info(url)
  }

  /** One queue pass: up to `n` captures, `concurrency` at a time. */
  async tick(n?: number): Promise<number> {
    if (!this.opts.enabled() || this.busy) return 0
    const active = this.opts.userActive?.() ?? false
    const urls = this.due(n ?? (active ? 2 : 8))
    if (!urls.length) return 0
    this.busy++
    try {
      let i = 0
      const worker = async () => {
        while (i < urls.length) await this.refresh(urls[i++])
      }
      await Promise.all(Array.from({ length: Math.max(1, Math.min(this.opts.concurrency ?? 1, 2)) }, worker))
      return urls.length
    } finally {
      this.busy--
    }
  }

  start(intervalMs = 90000): void {
    this.stop()
    this.timer = setInterval(() => void this.tick().catch((e) => log.warn('preview tick', e)), intervalMs)
    this.timer.unref()
    setTimeout(() => void this.tick().catch(() => undefined), 30000).unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stats(): { count: number; bytes: number; failed: number } {
    const r = this.db.prepare("SELECT SUM(status = 'ok') ok, SUM(status = 'failed') failed, COALESCE(SUM(bytes), 0) bytes FROM previews").get() as Row
    return { count: (r.ok as number) ?? 0, bytes: (r.bytes as number) ?? 0, failed: (r.failed as number) ?? 0 }
  }

  /** 清空预览缓存: delete files + index. */
  clear(): number {
    const n = this.stats().count
    this.db.prepare('DELETE FROM previews').run()
    for (const f of readdirSync(this.dir)) {
      try {
        if (statSync(join(this.dir, f)).isFile()) unlinkSync(join(this.dir, f))
      } catch {
        /* locked */
      }
    }
    this.opts.onChange?.()
    return n
  }

  /** Remove files no longer referenced (e.g. after a crash). */
  sweep(): void {
    const keep = new Set((this.db.prepare('SELECT path FROM previews WHERE path IS NOT NULL').all() as Row[]).map((r) => r.path as string))
    for (const f of readdirSync(this.dir)) if (!keep.has(f)) rmSync(join(this.dir, f), { force: true })
  }
}
