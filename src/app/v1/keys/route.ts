import { getPublicKeyInfo } from '@/lib/signing'

// GET /v1/keys —— 公开签名公钥，供 Runner 验证 manifest 签名
export async function GET() {
  const info = getPublicKeyInfo()
  if (!info) return Response.json({ error: '未配置签名密钥' }, { status: 404 })
  return Response.json(info, { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
