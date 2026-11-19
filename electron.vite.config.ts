import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** Strict CSP in production. Dev adds what Vite HMR needs (inline React-refresh preamble + websocket). */
function csp(): Plugin {
  let dev = false
  return {
    name: 'tabnest-csp',
    configResolved(c) {
      dev = c.command === 'serve'
    },
    transformIndexHtml(html) {
      const policy = [
        "default-src 'none'",
        dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
        "img-src 'self' data: tabnest-preview: https://www.google.com https://*.gstatic.com",
        dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
      ].join('; ')
      return html.replace('%CSP%', policy)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          // Off-main-thread SNSS / locked-session reader (utilityProcess).
          'live-worker': resolve(__dirname, 'electron/browsers/live-worker.ts'),
          // Off-main AI enrichment: page fetch + extraction + segmentation + vectors (utilityProcess).
          'ai-worker': resolve(__dirname, 'electron/ai/ai-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/preload.ts') } } }
  },
  renderer: {
    root: '.',
    build: { rollupOptions: { input: { index: resolve(__dirname, 'index.html') } } },
    plugins: [react(), csp()]
  }
})
