import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeBrowsers } from '../electron/close'

// Real process test: a copy of `sleep` named "firefox" must be terminated gracefully via SIGTERM.
describe.runIf(process.platform === 'linux')('closeBrowsers (linux)', () => {
  it('SIGTERMs a running process by name and reports it closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn-close-'))
    const bin = join(dir, 'firefox')
    copyFileSync('/bin/sleep', bin)
    const child = spawn(bin, ['60'], { stdio: 'ignore' })
    let signal: string | null = null
    child.on('exit', (_c, s) => (signal = s))
    await new Promise((r) => setTimeout(r, 300))
    const [res] = await closeBrowsers(['firefox'])
    await new Promise((r) => setTimeout(r, 100))
    expect(res).toMatchObject({ id: 'firefox', closed: true, forced: false })
    expect(signal).toBe('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('reports unknown browsers without throwing', async () => {
    expect((await closeBrowsers(['nope']))[0]).toMatchObject({ closed: false, error: '未知浏览器' })
  })
})
