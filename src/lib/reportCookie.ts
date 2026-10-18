import { createHash, createHmac } from 'node:crypto'

/** Called only after Payload has authenticated this request and its site owner. */
export function bindReportCookie(request: Request, jobId: string, owner: string) {
  const encoded = (request.headers.get('cookie') || '').split(';')
    .map(value => value.trim()).find(value => value.startsWith('payload-token='))?.slice('payload-token='.length)
  const session = encoded ? decodeURIComponent(encoded) : ''
  const secret = process.env.GEWU_INTERNAL_API_TOKEN?.trim()
  if (!session || !secret || !/^[A-Za-z0-9_-]{43}$/.test(owner) || !/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) {
    throw new Error('报告登录会话不可用')
  }
  // Signature verification already happened in relayActor; decode only expiry
  // so this grant cannot extend the authenticated session's remaining lifetime.
  const payload = JSON.parse(Buffer.from(session.split('.')[1] || '', 'base64url').toString())
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now) throw new Error('登录会话已到期')
  const expires = Math.min(now + 3600, payload.exp)
  const sessionDigest = createHash('sha256').update(session).digest('hex')
  const message = `gewu-account-view\n${jobId}\n${owner}\n${expires}\n${sessionDigest}`
  const signature = createHmac('sha256', secret).update(message).digest('hex')
  return { value: `${owner}.${expires}.${signature}`, maxAge: expires - now }
}
