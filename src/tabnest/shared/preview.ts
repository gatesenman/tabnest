/** Shared helpers for the page preview cache (renderer + main). */
export const PREVIEW_SCHEME = 'tabnest-preview'

/** base64url of the UTF-8 url (works in renderer and Node). */
export function encodePreviewKey(url: string): string {
  const bytes = new TextEncoder().encode(url)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function decodePreviewKey(key: string): string {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4)
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}
/** img src for a url's cached thumbnail; `v` busts the renderer cache after a refresh. */
export function previewSrc(url: string, v?: string | number | null): string {
  return `${PREVIEW_SCHEME}://img/${encodePreviewKey(url)}${v ? `?v=${encodeURIComponent(String(v))}` : ''}`
}
export const canPreview = (url: string) => /^https?:\/\//i.test(url) && !/^https?:\/\/(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(url)
