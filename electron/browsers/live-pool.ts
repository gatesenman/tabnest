/**
 * Offloads captureLive (locked-file copy + SNSS parse) to an Electron utilityProcess so the
 * first startup scan does not freeze the main process ~6s after first paint. Falls back to
 * in-process sync captureLive when utilityProcess is unavailable (Vitest / early boot).
 * Locked-file cache lives inside the worker (shared across all requests through this pool).
 */
import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import log from 'electron-log/main'
import { captureLive, type LiveCapture } from './read'
import type { ProfileInfo } from './discover'

type Req = { id: number; profiles: ProfileInfo[]; includeClosed?: boolean }
type Res = { id: number; ok: true; result: LiveCapture } | { id: number; ok: false; error: string }

let child: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: LiveCapture) => void; reject: (e: Error) => void }>()
let starting: Promise<UtilityProcess | null> | null = null

function workerScript(): string {
  // electron-vite emits out/main/live-worker.js next to index.js
  return join(__dirname, 'live-worker.js')
}

function canFork(): boolean {
  if (process.env.VITEST || process.env.TABNEST_LIVE_SYNC === '1') return false
  try {
    return typeof utilityProcess?.fork === 'function' && app.isReady()
  } catch {
    return false
  }
}

function attach(proc: UtilityProcess): void {
  proc.on('message', (msg: Res) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error || 'live-worker failed'))
  })
  proc.on('exit', (code) => {
    log.warn(`live-worker exited code=${code}`)
    child = null
    for (const [, p] of pending) p.reject(new Error(`live-worker exited (${code})`))
    pending.clear()
  })
}

async function ensureChild(): Promise<UtilityProcess | null> {
  if (child) return child
  if (!canFork()) return null
  if (starting) return starting
  starting = (async () => {
    try {
      const script = workerScript()
      const proc = utilityProcess.fork(script, [], { serviceName: 'tabnest-live', stdio: 'pipe' })
      attach(proc)
      child = proc
      log.info(`live-worker started: ${script}`)
      return proc
    } catch (e) {
      log.warn('live-worker fork failed; using in-process captureLive', e)
      return null
    } finally {
      starting = null
    }
  })()
  return starting
}

/** Run captureLive off the main thread when possible. */
export async function captureLiveAsync(profiles: ProfileInfo[], includeClosed = false): Promise<LiveCapture> {
  const proc = await ensureChild()
  if (!proc) return captureLive(profiles, includeClosed)
  const id = nextId++
  try {
    return await new Promise<LiveCapture>((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id)
        reject(new Error('live-worker timeout'))
      }, 120_000)
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(t)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        }
      })
      const msg: Req = { id, profiles, includeClosed }
      proc.postMessage(msg)
    })
  } catch (e) {
    log.warn('live-worker request failed; falling back to sync', e)
    return captureLive(profiles, includeClosed)
  }
}

export function disposeLivePool(): void {
  if (child) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    child = null
  }
  pending.clear()
}
