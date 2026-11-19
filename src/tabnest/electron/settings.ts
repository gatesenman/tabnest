import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import type { Repo } from './db'
import type { Density, PublicSettings, ThemeSource } from '../shared/types'

interface Stored {
  theme: ThemeSource
  density: Density
  autoSnapshotMinutes: number
  shutdownAfterClose: boolean
  captureHistory: boolean
  selectedProfiles: string[]
  linkCheckConcurrency: number
  linkCheckTimeoutMs: number
  backupDir: string
  autoBackup: boolean
  launchAtLogin: boolean
  autoUpdate: boolean
  aiBaseUrl: string
  aiModel: string
  autoOrganize: boolean
  autoOrganizeThreshold: number
  groupThreshold: number
  aiCloudOrganize: boolean
  aiFetchPages: boolean
  previewAuto: boolean
  aiDailyTokenCap: number
  aiEmbedModel: string
}

const defaults = (): Stored => ({
  theme: 'system',
  density: 'comfortable',
  autoSnapshotMinutes: 30,
  shutdownAfterClose: false,
  captureHistory: false,
  selectedProfiles: [],
  linkCheckConcurrency: 5,
  linkCheckTimeoutMs: 8000,
  backupDir: join(app.getPath('userData'), 'backups'),
  autoBackup: true,
  launchAtLogin: false,
  autoUpdate: false,
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini',
  autoOrganize: true,
  autoOrganizeThreshold: 0.75,
  groupThreshold: 8,
  aiCloudOrganize: false,
  aiFetchPages: true,
  previewAuto: true,
  aiDailyTokenCap: 200000,
  aiEmbedModel: ''
})

export class Settings {
  constructor(private repo: Repo) {}

  get(): Stored & { onboardingDone: boolean } {
    const raw = this.repo.getSetting('prefs')
    return { ...defaults(), ...(raw ? (JSON.parse(raw) as Partial<Stored>) : {}), onboardingDone: this.repo.getSetting('onboardingDone') === '1' }
  }

  setOnboardingDone(): void {
    this.repo.setSetting('onboardingDone', '1')
  }

  update(patch: Partial<Stored>): Stored {
    const { onboardingDone: _skip, ...cur } = this.get()
    void _skip
    const next = { ...cur, ...patch }
    this.repo.setSetting('prefs', JSON.stringify(next))
    return next
  }

  /** AI key is encrypted with the OS keychain (safeStorage); never stored in plain text. */
  setAiKey(key: string | null): void {
    if (!key) return this.repo.setSetting('aiKeyEnc', null)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法安全保存密钥。可改用环境变量 OPENAI_API_KEY。')
    this.repo.setSetting('aiKeyEnc', safeStorage.encryptString(key).toString('base64'))
  }

  getAiKey(): string | null {
    const enc = this.repo.getSetting('aiKeyEnc')
    if (enc && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        return null
      }
    }
    return process.env.OPENAI_API_KEY || null
  }

  public(dataPath: string, logPath: string): PublicSettings {
    const s = this.get()
    return {
      ...s,
      hasAiKey: !!this.getAiKey(),
      aiKeyEncryptionAvailable: safeStorage.isEncryptionAvailable(),
      dataPath,
      logPath,
      version: app.getVersion()
    }
  }
}
