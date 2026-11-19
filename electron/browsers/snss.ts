/**
 * Chromium SNSS ("session service") parser.
 *
 * File layout:  "SNSS" | int32 version (1 or 3) | command*
 * Command:      uint16 size | uint8 id | payload (size - 1 bytes)
 *
 * Session files (Session_*, "Current Session") use SessionService command ids; Tabs_* / "Current Tabs"
 * use TabRestoreService ids (recently closed). Payloads are either fixed structs (little endian,
 * int32 ids) or base::Pickle (uint32 payload length header, 4-byte aligned fields).
 * Reference: components/sessions/core/session_service_commands.cc and tab_restore_service_impl.cc.
 */

export const SESSION_CMD = {
  SetTabWindow: 0,
  SetTabIndexInWindow: 2,
  UpdateTabNavigation: 6,
  SetSelectedNavigationIndex: 7,
  SetSelectedTabInIndex: 8,
  SetWindowType: 9,
  SetPinnedState: 12,
  TabClosed: 16,
  WindowClosed: 17,
  SetActiveWindow: 20,
  LastActiveTime: 21,
  TabNavigationPathPruned: 24,
  SetTabGroup: 25
} as const

export const RESTORE_CMD = {
  UpdateTabNavigation: 1,
  RestoredEntry: 2,
  Window: 3,
  SelectedNavigationInTab: 4,
  PinnedState: 5
} as const

export interface SnssCommand {
  id: number
  payload: Buffer
}

export interface Navigation {
  index: number
  url: string
  title: string
}

export interface SessionTab {
  id: number
  windowId: number
  index: number
  pinned: boolean
  url: string
  title: string
  lastActive: number | null
  navigations: Navigation[]
}

export interface SessionWindow {
  id: number
  selectedTab: number
  tabs: SessionTab[]
}

export class SnssError extends Error {}

export function readCommands(buf: Buffer): { version: number; commands: SnssCommand[] } {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'SNSS') throw new SnssError('不是 SNSS 会话文件')
  const version = buf.readInt32LE(4)
  if (version < 1 || version > 4) throw new SnssError(`不支持的 SNSS 版本 ${version}`)
  const commands: SnssCommand[] = []
  let p = 8
  while (p + 2 <= buf.length) {
    const size = buf.readUInt16LE(p)
    p += 2
    // A truncated trailing command means the browser was mid-write; keep what we have.
    if (size === 0 || p + size > buf.length) break
    commands.push({ id: buf.readUInt8(p), payload: buf.subarray(p + 1, p + size) })
    p += size
  }
  return { version, commands }
}

/** Minimal base::Pickle reader. */
export class PickleReader {
  private p = 4
  private readonly end: number
  constructor(private b: Buffer) {
    if (b.length < 4) throw new SnssError('pickle too short')
    this.end = Math.min(b.length, 4 + b.readUInt32LE(0))
  }
  private need(n: number) {
    if (this.p + n > this.end) throw new SnssError('pickle overrun')
  }
  int(): number {
    this.need(4)
    const v = this.b.readInt32LE(this.p)
    this.p += 4
    return v
  }
  string(): string {
    const len = this.int()
    if (len < 0) throw new SnssError('bad string length')
    this.need(len)
    const s = this.b.toString('utf8', this.p, this.p + len)
    this.p += (len + 3) & ~3
    return s
  }
  string16(): string {
    const chars = this.int()
    if (chars < 0) throw new SnssError('bad string16 length')
    const bytes = chars * 2
    this.need(bytes)
    const s = this.b.toString('utf16le', this.p, this.p + bytes)
    this.p += (bytes + 3) & ~3
    return s
  }
}

function parseNavigation(payload: Buffer): { tabId: number; nav: Navigation } | null {
  try {
    const r = new PickleReader(payload)
    const tabId = r.int()
    const index = r.int()
    const url = r.string()
    let title = ''
    try {
      title = r.string16()
    } catch {
      /* some entries omit the title */
    }
    return { tabId, nav: { index, url, title } }
  } catch {
    return null
  }
}

const i32 = (b: Buffer, o: number) => (b.length >= o + 4 ? b.readInt32LE(o) : 0)

interface TabState {
  id: number
  windowId: number
  index: number
  pinned: boolean
  selectedNav: number
  lastActive: number | null
  navs: Map<number, Navigation>
}

/** Rebuild the live window → tab tree from a Session_* / "Current Session" file. */
export function parseSession(buf: Buffer): SessionWindow[] {
  const { commands } = readCommands(buf)
  const tabs = new Map<number, TabState>()
  const windows = new Map<number, { selectedTab: number }>()
  const closedTabs = new Set<number>()
  const closedWindows = new Set<number>()
  const tab = (id: number): TabState => {
    let t = tabs.get(id)
    if (!t) {
      t = { id, windowId: -1, index: 0, pinned: false, selectedNav: -1, lastActive: null, navs: new Map() }
      tabs.set(id, t)
    }
    return t
  }
  for (const { id, payload: b } of commands) {
    switch (id) {
      case SESSION_CMD.SetTabWindow: {
        const t = tab(i32(b, 4))
        t.windowId = i32(b, 0)
        if (!windows.has(t.windowId)) windows.set(t.windowId, { selectedTab: 0 })
        closedTabs.delete(t.id)
        break
      }
      case SESSION_CMD.SetTabIndexInWindow:
        tab(i32(b, 0)).index = i32(b, 4)
        break
      case SESSION_CMD.UpdateTabNavigation: {
        const r = parseNavigation(b)
        if (r) tab(r.tabId).navs.set(r.nav.index, r.nav)
        break
      }
      case SESSION_CMD.SetSelectedNavigationIndex:
        tab(i32(b, 0)).selectedNav = i32(b, 4)
        break
      case SESSION_CMD.SetSelectedTabInIndex: {
        const w = i32(b, 0)
        windows.set(w, { selectedTab: i32(b, 4) })
        closedWindows.delete(w)
        break
      }
      case SESSION_CMD.SetPinnedState:
        tab(i32(b, 0)).pinned = b.length > 4 && b[4] !== 0
        break
      case SESSION_CMD.LastActiveTime:
        if (b.length >= 12) tab(i32(b, 0)).lastActive = Number(b.readBigInt64LE(4))
        break
      case SESSION_CMD.TabClosed:
        closedTabs.add(i32(b, 0))
        break
      case SESSION_CMD.WindowClosed:
        closedWindows.add(i32(b, 0))
        break
      case SESSION_CMD.TabNavigationPathPruned: {
        // {tab_id, index, count}: entries [index, index+count) were removed, later ones shift down.
        const t = tab(i32(b, 0))
        const start = i32(b, 4)
        const count = i32(b, 8)
        const next = new Map<number, Navigation>()
        for (const [k, v] of t.navs) {
          if (k < start) next.set(k, v)
          else if (k >= start + count) next.set(k - count, { ...v, index: k - count })
        }
        t.navs = next
        break
      }
      default:
        break
    }
  }
  const out = new Map<number, SessionWindow>()
  for (const t of tabs.values()) {
    if (closedTabs.has(t.id) || t.windowId < 0 || closedWindows.has(t.windowId) || !t.navs.size) continue
    const keys = [...t.navs.keys()].sort((a, b) => a - b)
    const cur = t.navs.get(t.selectedNav) ?? t.navs.get(keys[keys.length - 1])!
    let w = out.get(t.windowId)
    if (!w) {
      w = { id: t.windowId, selectedTab: windows.get(t.windowId)?.selectedTab ?? 0, tabs: [] }
      out.set(t.windowId, w)
    }
    w.tabs.push({
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      pinned: t.pinned,
      url: cur.url,
      title: cur.title,
      lastActive: t.lastActive,
      navigations: keys.map((k) => t.navs.get(k)!)
    })
  }
  const list = [...out.values()].filter((w) => w.tabs.length)
  for (const w of list) w.tabs.sort((a, b) => a.index - b.index || a.id - b.id)
  return list.sort((a, b) => a.id - b.id)
}

/** Recently closed tabs from a Tabs_* / "Current Tabs" file (TabRestoreService). Newest first. */
export function parseRecentlyClosed(buf: Buffer): Navigation[] {
  const { commands } = readCommands(buf)
  const entries = new Map<number, { navs: Map<number, Navigation>; selected: number; order: number }>()
  let order = 0
  for (const { id, payload } of commands) {
    if (id === RESTORE_CMD.UpdateTabNavigation) {
      const r = parseNavigation(payload)
      if (!r) continue
      let e = entries.get(r.tabId)
      if (!e) entries.set(r.tabId, (e = { navs: new Map(), selected: -1, order: order++ }))
      e.navs.set(r.nav.index, r.nav)
    } else if (id === RESTORE_CMD.SelectedNavigationInTab) {
      const e = entries.get(i32(payload, 0))
      if (e) e.selected = i32(payload, 4)
    } else if (id === RESTORE_CMD.RestoredEntry) {
      entries.delete(i32(payload, 0))
    }
  }
  return [...entries.values()]
    .sort((a, b) => b.order - a.order)
    .map((e) => e.navs.get(e.selected) ?? [...e.navs.values()].sort((a, b) => b.index - a.index)[0])
    .filter((n): n is Navigation => !!n)
}
