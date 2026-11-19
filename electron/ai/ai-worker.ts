/**
 * Utility-process entry for heavy AI work (page fetch + HTML extraction + segmentation + vectors), so the
 * Electron main process and UI never block. Parent sends { id, jobs, fetch }; we reply { id, ok, result }.
 */
import { runEnrichJobs, type EnrichJob, type EnrichOut } from './pipeline'

type Req = { id: number; jobs: EnrichJob[]; fetch: boolean }
type Res = { id: number; ok: true; result: EnrichOut[] } | { id: number; ok: false; error: string }

const port = (process as NodeJS.Process & { parentPort?: { on(event: 'message', cb: (e: { data: Req }) => void): void; postMessage(msg: Res): void } })
  .parentPort

function reply(msg: Res): void {
  if (port) port.postMessage(msg)
  else if (typeof process.send === 'function') process.send(msg)
}

async function handle(msg: Req): Promise<void> {
  try {
    reply({ id: msg.id, ok: true, result: await runEnrichJobs(msg.jobs ?? [], { fetch: !!msg.fetch }) })
  } catch (e) {
    reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

if (port) port.on('message', (e: { data: Req }) => void handle(e.data))
else process.on('message', (msg: Req) => void handle(msg))
