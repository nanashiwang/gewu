import { getPayload } from 'payload'
import config from '@payload-config'
import { getPublicKeyInfo } from '@/lib/signing'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

// GET /v1/keys —— 公开签名公钥，供 Runner 验证 manifest 签名
export async function GET() {
  const payload = await getPayload({ config })
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const info = getPublicKeyInfo(runtimeEnv)
  if (!info) return Response.json({ error: '未配置签名密钥' }, { status: 404 })
  return Response.json(info, { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
