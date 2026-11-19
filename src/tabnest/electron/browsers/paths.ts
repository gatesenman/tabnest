import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type BrowserId =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'opera'
  | 'chromium'
  | 'firefox'
  | 'qqbrowser'
  | '360se'
  | '360chrome'
  | 'sogou'
  | '2345'
  | 'liebao'
  | 'quark'
  | 'lenovo'

export interface BrowserSpec {
  id: BrowserId
  name: string
  family: 'chromium' | 'firefox'
  /** Absolute path of the browser's user-data / profiles root. */
  roots: string[]
  /** Chromium: relative path of Local State. Firefox: profiles.ini relative to root. */
  localState?: string
  /** Absolute path of the browser executable, if known (for "reopen in…"). */
  exe?: string[]
}

function env(name: string): string | undefined {
  return process.env[name]
}

function win(): BrowserSpec[] {
  const la = env('LOCALAPPDATA') ?? join(homedir(), 'AppData', 'Local')
  const ra = env('APPDATA') ?? join(homedir(), 'AppData', 'Roaming')
  const pf = env('PROGRAMFILES') ?? 'C:\\Program Files'
  const pf86 = env('PROGRAMFILES(X86)') ?? 'C:\\Program Files (x86)'
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      family: 'chromium',
      roots: [join(la, 'Google', 'Chrome', 'User Data')],
      exe: [
        join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(la, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      family: 'chromium',
      roots: [join(la, 'Microsoft', 'Edge', 'User Data')],
      exe: [join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    },
    {
      id: 'brave',
      name: 'Brave',
      family: 'chromium',
      roots: [join(la, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      exe: [join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), join(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
    },
    {
      id: 'vivaldi',
      name: 'Vivaldi',
      family: 'chromium',
      roots: [join(la, 'Vivaldi', 'User Data')],
      exe: [join(pf, 'Vivaldi', 'Application', 'vivaldi.exe'), join(la, 'Vivaldi', 'Application', 'vivaldi.exe')]
    },
    {
      id: 'opera',
      name: 'Opera',
      family: 'chromium',
      roots: [join(ra, 'Opera Software', 'Opera Stable')],
      exe: [join(la, 'Programs', 'Opera', 'opera.exe'), join(pf, 'Opera', 'opera.exe')]
    },
    {
      id: 'chromium',
      name: 'Chromium',
      family: 'chromium',
      roots: [join(la, 'Chromium', 'User Data')],
      exe: [join(la, 'Chromium', 'Application', 'chrome.exe')]
    },
    {
      id: 'qqbrowser',
      name: 'QQ浏览器',
      family: 'chromium',
      roots: [join(la, 'Tencent', 'QQBrowser', 'User Data')],
      exe: [join(pf, 'Tencent', 'QQBrowser', 'QQBrowser.exe'), join(pf86, 'Tencent', 'QQBrowser', 'QQBrowser.exe')]
    },
    {
      id: '360se',
      name: '360安全浏览器',
      family: 'chromium',
      roots: [join(ra, '360se6', 'User Data'), join(la, '360se6', 'User Data')],
      exe: [
        join(ra, '360se6', 'Application', '360se.exe'),
        join(pf86, '360', '360se6', 'Application', '360se.exe'),
        join(pf, '360', '360se6', 'Application', '360se.exe')
      ]
    },
    {
      id: '360chrome',
      name: '360极速浏览器',
      family: 'chromium',
      roots: [join(la, '360ChromeX', 'Chrome', 'User Data'), join(la, '360Chrome', 'Chrome', 'User Data')],
      exe: [join(la, '360ChromeX', 'Chrome', 'Application', '360ChromeX.exe'), join(la, '360Chrome', 'Chrome', 'Application', '360chrome.exe')]
    },
    {
      id: 'sogou',
      name: '搜狗浏览器',
      family: 'chromium',
      roots: [join(ra, 'SogouExplorer', 'Webkit'), join(la, 'SogouExplorer', 'User Data')],
      exe: [join(pf86, 'SogouExplorer', 'SogouExplorer.exe'), join(pf, 'SogouExplorer', 'SogouExplorer.exe')]
    },
    {
      id: '2345',
      name: '2345浏览器',
      family: 'chromium',
      roots: [join(la, '2345Explorer', 'User Data')],
      exe: [join(pf86, '2345Soft', '2345Explorer', '2345Explorer.exe'), join(pf, '2345Soft', '2345Explorer', '2345Explorer.exe')]
    },
    {
      id: 'liebao',
      name: '猎豹浏览器',
      family: 'chromium',
      roots: [join(la, 'liebao', 'User Data')],
      exe: [join(la, 'liebao', 'liebao.exe'), join(pf86, 'liebao', 'liebao.exe')]
    },
    {
      id: 'quark',
      name: '夸克浏览器',
      family: 'chromium',
      roots: [join(la, 'Quark', 'User Data')],
      exe: [join(la, 'Programs', 'Quark', 'quark.exe'), join(la, 'Quark', 'Application', 'quark.exe')]
    },
    {
      id: 'lenovo',
      name: '联想浏览器',
      family: 'chromium',
      roots: [join(la, 'Lenovo', 'SLBrowser', 'User Data')],
      exe: [join(la, 'Lenovo', 'SLBrowser', 'SLBrowser.exe'), join(pf86, 'Lenovo', 'SLBrowser', 'SLBrowser.exe')]
    },
    {
      id: 'firefox',
      name: 'Firefox',
      family: 'firefox',
      roots: [join(ra, 'Mozilla', 'Firefox')],
      exe: [join(pf, 'Mozilla Firefox', 'firefox.exe'), join(pf86, 'Mozilla Firefox', 'firefox.exe')]
    }
  ]
}

function mac(): BrowserSpec[] {
  const app = join(homedir(), 'Library', 'Application Support')
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      family: 'chromium',
      roots: [join(app, 'Google', 'Chrome')],
      exe: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      family: 'chromium',
      roots: [join(app, 'Microsoft Edge')],
      exe: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    },
    {
      id: 'brave',
      name: 'Brave',
      family: 'chromium',
      roots: [join(app, 'BraveSoftware', 'Brave-Browser')],
      exe: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
    },
    { id: 'vivaldi', name: 'Vivaldi', family: 'chromium', roots: [join(app, 'Vivaldi')], exe: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'] },
    { id: 'opera', name: 'Opera', family: 'chromium', roots: [join(app, 'com.operasoftware.Opera')], exe: ['/Applications/Opera.app/Contents/MacOS/Opera'] },
    { id: 'chromium', name: 'Chromium', family: 'chromium', roots: [join(app, 'Chromium')], exe: ['/Applications/Chromium.app/Contents/MacOS/Chromium'] },
    {
      id: 'qqbrowser',
      name: 'QQ浏览器',
      family: 'chromium',
      roots: [join(app, 'QQBrowser2'), join(app, 'Tencent', 'QQBrowser')],
      exe: ['/Applications/QQBrowser.app/Contents/MacOS/QQBrowser']
    },
    { id: 'firefox', name: 'Firefox', family: 'firefox', roots: [join(app, 'Firefox')], exe: ['/Applications/Firefox.app/Contents/MacOS/firefox'] }
  ]
}

function linux(): BrowserSpec[] {
  const c = join(homedir(), '.config')
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      family: 'chromium',
      roots: [join(c, 'google-chrome')],
      exe: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    },
    {
      id: 'chromium',
      name: 'Chromium',
      family: 'chromium',
      roots: [join(c, 'chromium'), join(c, 'chromium-browser')],
      exe: ['/usr/bin/chromium', '/usr/bin/chromium-browser', ...(process.env.TABNEST_CHROMIUM_EXE ? [process.env.TABNEST_CHROMIUM_EXE] : [])]
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      family: 'chromium',
      roots: [join(c, 'microsoft-edge')],
      exe: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
    },
    { id: 'brave', name: 'Brave', family: 'chromium', roots: [join(c, 'BraveSoftware', 'Brave-Browser')], exe: ['/usr/bin/brave-browser', '/usr/bin/brave'] },
    { id: 'vivaldi', name: 'Vivaldi', family: 'chromium', roots: [join(c, 'vivaldi')], exe: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable'] },
    { id: 'opera', name: 'Opera', family: 'chromium', roots: [join(c, 'opera')], exe: ['/usr/bin/opera'] },
    { id: 'firefox', name: 'Firefox', family: 'firefox', roots: [join(homedir(), '.mozilla', 'firefox')], exe: ['/usr/bin/firefox'] }
  ]
}

export function browserSpecs(platform: NodeJS.Platform = process.platform): BrowserSpec[] {
  if (platform === 'win32') return win()
  if (platform === 'darwin') return mac()
  return linux()
}

export function firstExisting(paths: string[] = []): string | null {
  for (const p of paths) if (p && existsSync(p)) return p
  return null
}
