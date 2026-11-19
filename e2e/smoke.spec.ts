import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('desktop shell: secure boot, menus, tree + grid, daily merge, recycle bin, close-all preview', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tabnest-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TABNEST_USER_DATA: userData, HOME: userData, XDG_CONFIG_HOME: join(userData, '.config') }
  })
  try {
    const win = await app.firstWindow()
    await expect(win).toHaveTitle(/TabNest/)

    // Security posture of the renderer
    const exposed = await win.evaluate(() => ({ node: typeof (globalThis as { require?: unknown }).require, bridge: Object.keys(window.tabnest ?? {}) }))
    expect(exposed.node).toBe('undefined')
    expect(exposed.bridge.sort()).toEqual(['invoke', 'on', 'platform'])
    await expect(win.evaluate(() => window.tabnest!.invoke('evil:channel'))).rejects.toThrow(/blocked/)

    // First run: welcome dialog (fresh profile, no leftover data) — dismiss for now
    await expect(win.getByTestId('welcome')).toBeVisible()
    await expect(win.getByTestId('welcome')).not.toContainText('旧数据')
    await win.getByRole('button', { name: '稍后' }).click()
    await expect(win.getByRole('status').first()).toContainText('自动快照')

    // Native-style chrome: custom title bar, menu bar, toolbar, tree, status bar
    await expect(win.locator('.titlebar')).toContainText('TabNest 页签巢')
    await expect(win.getByRole('menubar')).toContainText('文件')
    await expect(win.getByRole('tree')).toContainText('每日快照')
    await expect(win.getByRole('status').first()).toContainText('今日快照')
    // Alt+F opens the 文件 menu
    await win.keyboard.press('Alt+f')
    await expect(win.getByRole('menuitem', { name: /导出 JSON/ })).toBeVisible()
    await win.keyboard.press('Escape')
    await win.mouse.click(600, 400)

    // Local pairing API removed by design (1.3.5). Seed today's daily snapshot via session:create (paste path).
    const sid1 = await win.evaluate(async () =>
      window.tabnest!.invoke('session:create', {
        name: 'e2e',
        note: '',
        tags: [],
        tabs: [{ title: 'Example', url: 'https://example.com' }]
      })
    )
    expect(sid1).toBeTruthy()
    // Second capture the same day: one normalized duplicate + one new → still ONE daily snapshot, 2 rows.
    await win.evaluate(async () =>
      window.tabnest!.invoke('session:create', {
        name: 'e2e2',
        note: '',
        tags: [],
        tabs: [
          { title: 'Example Domain', url: 'http://www.example.com/?utm_source=x' },
          { title: 'Org', url: 'https://example.org/' }
        ]
      })
    )
    const days = win.locator('[role=treeitem][data-node^="day:"]')
    await expect(days).toHaveCount(1)
    await days.first().click()
    const rows = win.locator('.gr')
    await expect(rows).toHaveCount(2)
    await expect(win.getByRole('grid')).toContainText('Example Domain')

    // Select → details pane; Delete → recycle bin; restore from context menu
    await win.locator('.gr', { hasText: 'Org' }).click()
    await expect(win.getByTestId('details')).toContainText('example.org')
    await win.keyboard.press('Delete')
    await expect(rows).toHaveCount(1)
    await win.locator('[data-node="trash"]').click()
    await expect(rows).toHaveCount(1)
    await win.locator('.gr').first().click({ button: 'right' })
    await win.getByRole('menuitem', { name: '还原' }).click()
    await expect(rows).toHaveCount(0)

    // One-click close: confirm dialog appears; nothing is closed until the user confirms
    await win.getByRole('button', { name: '快照并关闭' }).click()
    await expect(win.getByRole('dialog', { name: '快照并关闭所有浏览器' })).toBeVisible()
    await expect(win.getByRole('button', { name: /保存并关闭/ })).toBeVisible()
    await win.getByRole('button', { name: '取消' }).click()

    // Command palette
    await win.keyboard.press('Control+K')
    await expect(win.getByRole('dialog', { name: '命令面板' })).toContainText('快照并关闭所有浏览器')
    await win.keyboard.press('Escape')

    // v1.3: reconciliation panel (under 浏览器), smart-organize panel, overview metrics
    await win.locator('[data-node="reconcile"]').click()
    await expect(win.getByTestId('reconcile')).toBeVisible()
    await win.locator('[data-node="autoorg"]').click()
    await expect(win.getByTestId('autoorg')).toContainText('本地引擎')
    await win.locator('[data-node="overview"]').click()
    await expect(win.getByTestId('overview')).toContainText('今日标签')
    await expect(win.getByTestId('overview')).toContainText('2')
    await win.screenshot({ path: 'test-results/smoke.png' })
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
