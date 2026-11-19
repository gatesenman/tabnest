// Captures docs/screenshots/main-{light,dark}.png under xvfb from a throwaway data dir.
//   xvfb-run -a node scripts/screenshots.mjs
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronBin = (await import('electron')).default
for (const theme of ['light', 'dark']) {
  const dir = mkdtempSync(join(tmpdir(), 'tabnest-shot-'))
  execFileSync(electronBin, ['node_modules/tsx/dist/cli.mjs', 'scripts/screenshot-data.ts', dir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  })
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TABNEST_USER_DATA: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') } })
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setBounds({ x: 0, y: 0, width: 1440, height: 860 })
  })
  await win.evaluate((t) => window.tabnest.invoke('settings:update', { theme: t, density: 'compact' }), theme)
  await win.reload()
  await win.waitForSelector('[role=treeitem]')
  await win.waitForTimeout(400)
  await win.locator('[role=treeitem][data-node^="day:"]').last().click()
  await win.locator('.gr', { hasText: 'electron/electron' }).click()
  await win.keyboard.down('Control')
  await win.locator('.gr', { hasText: 'Pull requests' }).click()
  await win.locator('.gr', { hasText: 'electron/electron' }).click()
  await win.locator('.gr', { hasText: 'electron/electron' }).click()
  await win.keyboard.up('Control')
  await win.waitForTimeout(300)
  await win.screenshot({ path: `docs/screenshots/main-${theme}.png` })
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  console.log('saved', theme)
}
