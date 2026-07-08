import { buildAnchorTimestampRequest, MAX_ANCHOR_VERIFY_BYTES } from '@/lib/anchorVerify'
import { readJsonBodyWithLimit } from '@/lib/requestBody'

// POST /v1/anchors/timestamp-request —— 为外锚 manifest 生成第三方时间戳请求包，不接触私钥。
export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, MAX_ANCHOR_VERIFY_BYTES, '时间戳请求输入过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const body = parsed.value && typeof parsed.value === 'object' ? parsed.value as any : {}
  let manifest: any
  try {
    manifest = typeof body.manifest === 'string' ? JSON.parse(body.manifest) : body.manifest
  } catch {
    return Response.json({ error: 'manifest JSON 无效' }, { status: 400 })
  }
  if (!manifest || typeof manifest !== 'object') return Response.json({ error: '缺少 manifest' }, { status: 400 })
  const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim().slice(0, 80) : 'rfc3161'
  return Response.json({ ok: true, timestampRequest: buildAnchorTimestampRequest(manifest, provider) })
}
