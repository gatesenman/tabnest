import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { Repo } from './db'
import { exportBookmarkHtml, type ExportFolder } from '../shared/bookmarks'

export function buildHtmlExport(repo: Repo): string {
  const snap = repo.snapshot()
  const folders: ExportFolder[] = snap.collections.map((c) => ({
    name: c.name,
    items: snap.tabs.filter((t) => t.collectionId === c.id).map((t) => ({ title: t.title, url: t.url, createdAt: t.createdAt }))
  }))
  for (const s of snap.sessions) {
    const items = snap.tabs.filter((t) => t.sessionId === s.id && !t.collectionId)
    if (items.length) folders.push({ name: `未整理 · ${s.name}`, items: items.map((t) => ({ title: t.title, url: t.url, createdAt: t.createdAt })) })
  }
  return exportBookmarkHtml(folders.filter((f) => f.items.length))
}

/** Writes tabnest-YYYY-MM-DD.json into dir and keeps the newest `keep` files. */
export function writeBackup(repo: Repo, dir: string, keep = 14): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `tabnest-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(file, JSON.stringify(repo.exportAll(), null, 2), 'utf-8')
  const old = readdirSync(dir)
    .filter((f) => /^tabnest-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse()
    .slice(keep)
  for (const f of old) unlinkSync(join(dir, f))
  log.info('backup written', file)
  return file
}

export function dailyBackupIfNeeded(repo: Repo, dir: string): void {
  const today = new Date().toISOString().slice(0, 10)
  if (repo.getSetting('lastBackupDay') === today) return
  try {
    writeBackup(repo, dir)
    repo.setSetting('lastBackupDay', today)
  } catch (e) {
    log.error('auto backup failed', e)
  }
}
