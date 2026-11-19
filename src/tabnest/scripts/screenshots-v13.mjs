// v1.3 screenshots: 概览 + 数量对账 + 智能整理, from a throwaway data dir with fake browser profiles
// built from the real Chromium session fixture (no seed data ships with the app).
//   xvfb-run -a node scripts/screenshots-v13.mjs
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronBin = (await import('electron')).default
const fixture = 'tests/fixtures/chromium-1248.Session'

function fakeBrowser(home, dir, files) {
  const prof = join(home, '.config', dir, 'Default')
  mkdirSync(join(prof, 'Sessions'), { recursive: true })
  writeFileSync(join(prof, 'Preferences'), JSON.stringify({ profile: { name: '默认' } }))
  writeFileSync(join(home, '.config', dir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: '默认' } } } }))
  for (const f of files) {
    const p = join(prof, 'Sessions', f.name)
    copyFileSync(fixture, p)
    const t = new Date(Date.now() - f.ageMin * 60000)
    utimesSync(p, t, t)
    if (f.locked) chmodSync(p, 0o000) // simulates Edge/Vivaldi's exclusive lock: newest file unreadable
  }
}

const dir = mkdtempSync(join(tmpdir(), 'tabnest-shot13-'))
execFileSync(electronBin, ['node_modules/tsx/dist/cli.mjs', 'scripts/screenshot-data.ts', dir], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit'
})
fakeBrowser(dir, 'microsoft-edge', [
  { name: 'Session_13400000000000001', ageMin: 52 },
  { name: 'Session_13400000000000002', ageMin: 1, locked: true }
])
fakeBrowser(dir, 'opera', [{ name: 'Session_13400000000000003', ageMin: 2 }])
fakeBrowser(dir, 'vivaldi', [
  { name: 'Session_13400000000000004', ageMin: 2 * 24 * 60 + 30 },
  { name: 'Session_13400000000000005', ageMin: 3, locked: true }
])

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TABNEST_USER_DATA: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), TABNEST_E2E: '1' }
})
try {
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setBounds({ x: 0, y: 0, width: 1440, height: 860 })
  })
  await win.evaluate(() => window.tabnest.invoke('settings:update', { theme: 'light', density: 'compact' }))
  await win.evaluate(() => window.tabnest.invoke('onboarding:complete', { profileKeys: [], bookmarkKeys: [], captureNow: false }))
  await win.evaluate(() => window.tabnest.invoke('capture:now', {}))
  await win.evaluate(() => window.tabnest.invoke('org:run', { review: true }))
  await win.reload()
  await win.waitForSelector('[role=treeitem]')
  await win.waitForTimeout(1500)
  for (const [node, file, ready] of [
    ['overview', 'overview', 'overview'],
    ['reconcile', 'reconcile', 'reconcile'],
    ['autoorg', 'autoorg', 'autoorg']
  ]) {
    await win.locator(`[data-node="${node}"]`).click()
    await win.getByTestId(ready).waitFor()
    await win.waitForTimeout(700)
    await win.screenshot({ path: `docs/screenshots/${file}.png` })
    console.log('saved', file)
  }
} finally {
  await app.close()
  for (const d of ['microsoft-edge', 'vivaldi'])
    for (const n of ['Session_13400000000000002', 'Session_13400000000000005'])
      try {
        chmodSync(join(dir, '.config', d, 'Default', 'Sessions', n), 0o644)
      } catch {
        /* not this browser */
      }
  rmSync(dir, { recursive: true, force: true })
}
