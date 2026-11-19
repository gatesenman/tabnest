import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('1.4 AI: smart search chips + ranking, weekly digest, near-duplicate merge with undo', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tabnest-e2e-ai-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TABNEST_USER_DATA: userData, HOME: userData, XDG_CONFIG_HOME: join(userData, '.config'), TABNEST_E2E: '1' }
  })
  try {
    const win = await app.firstWindow()
    await win.getByRole('button', { name: '稍后' }).click()
    await win.evaluate(() =>
      window.tabnest!.invoke('session:create', {
        name: 'seed',
        tabs: [
          { title: 'Raindrop.io — All-in-one bookmark manager', url: 'https://raindrop.io/' },
          { title: 'OneTab 标签页与书签管理', url: 'https://www.onetab.com/' },
          { title: 'facebook/react', url: 'https://github.com/facebook/react' },
          { title: 'Same page', url: 'https://example.org/p?utm_source=a' },
          { title: 'Same page', url: 'https://m.example.org/p/' },
          { title: 'Introducing System One Models & Jev - TypeSafe AI Blog', url: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev' }
        ]
      })
    )
    await win.evaluate(() => window.tabnest!.invoke('ai:summarize', { tabIds: [] }))
    // 智能搜索
    await win.getByTestId('ai-search-toggle').click()
    await win.getByLabel('搜索').fill('今天的书签管理工具')
    await expect(win.getByTestId('smart-bar')).toContainText('时间：今天')
    await expect(win.locator('.pane-header')).toContainText('智能搜索')
    await win.screenshot({ path: 'test-results/ai-smart-search.png' })
    await win.getByLabel('清除').click()
    // 1.4.1 属性面板：「AI 摘要」卡片置顶，重新生成有加载态，原始描述折叠
    await win.getByLabel('搜索').fill('TypeSafe')
    await win.getByText('Introducing System One Models & Jev - TypeSafe AI Blog').first().click()
    const card = win.getByTestId('ai-summary')
    await expect(card).toContainText('AI 摘要')
    await expect(win.getByTestId('ai-cloud-hint')).toContainText('去配置')
    await card.getByTestId('summarize-btn').click()
    await expect(card.getByTestId('summarize-btn')).toBeEnabled({ timeout: 30000 })
    await expect(card.locator('.ai-summary')).toContainText('TypeSafe', { timeout: 30000 })
    await expect(card.getByTestId('ai-engine')).toContainText('本地摘要')
    await expect(card.getByTestId('ai-points')).toBeVisible()
    await expect(card.getByTestId('enrich-status')).toContainText('网页正文')
    await win.screenshot({ path: 'test-results/ai-summary-card.png' })
    // 1.4.2 网页预览图：属性面板刷新预览 → 离屏截图 → tabnest-preview:// 显示；列表缩略图
    await win.getByTestId('preview-refresh').click()
    await expect(win.getByTestId('preview-img')).toBeVisible({ timeout: 40000 })
    const nat = await win.getByTestId('preview-img').evaluate((img: HTMLImageElement) => img.naturalWidth)
    expect(nat).toBe(480)
    await win.getByLabel('清除').click()
    await win.getByLabel('搜索').fill('TypeSafe')
    await expect(win.locator('img.thumb').first()).toBeVisible({ timeout: 10000 })
    await win.screenshot({ path: 'test-results/preview-thumbs.png' })
    await win.getByLabel('清除').click()
    // 概览：本周 AI 摘要
    await win.getByRole('treeitem', { name: /概览/ }).first().click()
    await expect(win.getByTestId('weekly-digest')).toContainText('本周 AI 摘要')
    // 智能整理：重复项 → 一键合并 → 撤销
    await win.getByRole('treeitem', { name: /智能整理/ }).click()
    await win.getByRole('tab', { name: /重复项/ }).click()
    await win.getByTestId('dedupe-all').click()
    await win.getByRole('tab', { name: /自动整理记录/ }).click()
    await expect(win.getByTestId('org-log').first()).toContainText('合并重复')
    await win.screenshot({ path: 'test-results/ai-autoorg.png' })
    await win.getByTestId('org-log').first().getByRole('button', { name: '撤销' }).click()
    await expect(win.getByTestId('org-log').first()).toContainText('已撤销')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
