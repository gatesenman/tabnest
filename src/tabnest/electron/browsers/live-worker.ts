/**
 * Utility-process entry: Chromium SNSS / locked-file reads run here so the Electron main
 * process (and UI) stay responsive. Parent sends { id, profiles, includeClosed }; we reply
 * with { id, ok, result } or { id, ok:false, error }. Keeps the 5-min lockedCache in this process.
 */
import { captureLive, type LiveCapture } from './read'
import type { ProfileInfo } from './discover'

type Req = { id: number; profiles: ProfileInfo[]; includeClosed?: boolean }
type Res = { id: number; ok: true; result: LiveCapture } | { id: number; ok: false; error: string }

const port = (process as NodeJS.Process & { parentPort?: { on(event: 'message', cb: (e: { data: Req }) => void): void; postMessage(msg: Res): void } })
  .parentPort

function reply(msg: Res): void {
  if (port) port.postMessage(msg)
  else if (typeof process.send === 'function') process.send(msg)
}

function handle(msg: Req): void {
  try {
    const result = captureLive(msg.profiles ?? [], !!msg.includeClosed)
    reply({ id: msg.id, ok: true, result })
  } catch (e) {
    reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

if (port) {
  port.on('message', (e: { data: Req }) => handle(e.data))
} else if (process.env.TABNEST_LIVE_WORKER_SELFTEST === '1') {
  // Allow a quick ELECTRON_RUN_AS_NODE smoke without a parent.
  handle({ id: 0, profiles: [], includeClosed: false })
} else {
  process.on('message', (msg: Req) => handle(msg))
}
