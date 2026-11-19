/** Runs enrichment jobs in the `tabnest-ai` utilityProcess; falls back to in-process when forking is unavailable (tests). */
import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import log from 'electron-log/main'
import { runEnrichJobs, type EnrichJob, type EnrichOut } from './pipeline'

let child: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: EnrichOut[]) => void; reject: (e: Error) => void }>()

function canFork(): boolean {
  if (process.env.VITEST || process.env.TABNEST_AI_SYNC === '1') return false
  try {
    return typeof utilityProcess?.fork === 'function' && app.isReady()
  } catch {
    return false
  }
}

function ensureChild(): UtilityProcess | null {
  if (child) return child
  if (!canFork()) return null
  try {
    const proc = utilityProcess.fork(join(__dirname, 'ai-worker.js'), [], { serviceName: 'tabnest-ai', stdio: 'pipe' })
    proc.on('message', (msg: { id: number; ok: boolean; result?: EnrichOut[]; error?: string }) => {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result ?? [])
      else p.reject(new Error(msg.error || 'ai-worker failed'))
    })
    proc.on('exit', (code) => {
      log.warn(`ai-worker exited code=${code}`)
      child = null
      for (const [, p] of pending) p.reject(new Error(`ai-worker exited (${code})`))
      pending.clear()
    })
    child = proc
    log.info('ai-worker started')
    return proc
  } catch (e) {
    log.warn('ai-worker fork failed; running in-process', e)
    return null
  }
}

export async function enrichJobs(jobs: EnrichJob[], fetchPages: boolean): Promise<EnrichOut[]> {
  if (!jobs.length) return []
  const proc = ensureChild()
  if (!proc) return runEnrichJobs(jobs, { fetch: fetchPages })
  const id = nextId++
  return new Promise<EnrichOut[]>((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id)
      reject(new Error('ai-worker timeout'))
    }, 180_000)
    pending.set(id, {
      resolve: (r) => (clearTimeout(t), resolve(r)),
      reject: (e) => (clearTimeout(t), reject(e))
    })
    proc.postMessage({ id, jobs, fetch: fetchPages })
  })
}

export function disposeAiPool(): void {
  try {
    child?.kill()
  } catch {
    /* ignore */
  }
  child = null
  pending.clear()
}
