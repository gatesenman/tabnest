const MIN = Date.UTC(1995, 0, 1)
const MAX_AHEAD = 2 * 86400000

/** Epoch ms if `v` is a plausible real timestamp (1995 … now+2d), else null. Never throws. */
export function safeMs(v: unknown, now = Date.now()): number | null {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(ms) && ms >= MIN && ms <= now + MAX_AHEAD ? ms : null
}

/** ISO string for a plausible timestamp, else null (instead of `RangeError: Invalid time value`). */
export function safeIso(v: unknown, now = Date.now()): string | null {
  const ms = safeMs(v, now)
  return ms == null ? null : new Date(ms).toISOString()
}
