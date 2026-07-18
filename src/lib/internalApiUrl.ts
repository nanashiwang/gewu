export function internalApiUrl(path: string, requestUrl: string): string {
  const configured = process.env.INTERNAL_SERVER_URL?.trim()
  const port = String(process.env.PORT || '3000').trim()
  const fallback = process.env.NODE_ENV === 'production'
    ? `http://127.0.0.1:${/^\d{1,5}$/.test(port) ? port : '3000'}`
    : new URL(requestUrl).origin
  const base = new URL(configured || fallback)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('INTERNAL_SERVER_URL 配置无效')
  }
  return new URL(path, `${base.origin}/`).toString()
}