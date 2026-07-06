import { getPayload } from 'payload'
import config from '@payload-config'
import { genUserCode, randomToken } from '@/lib/runnerAuth'
import { getClientIp, hashIp } from '@/lib/clientMeta'
import { getServerUrl } from '@/lib/siteUrl'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

// POST /v1/auth/device/code —— Runner 申请设备码（无需登录）
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const runtimeEnv = await resolveRuntimeEnv(payload)
  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* 容忍空 body */
  }

  const ipHashValue = hashIp(getClientIp(request.headers, runtimeEnv))
  if (ipHashValue) {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const recent = await payload.count({
      collection: 'device-codes',
      where: { and: [{ ipHash: { equals: ipHashValue } }, { createdAt: { greater_than_equal: since } }] },
      overrideAccess: true,
    })
    if (recent.totalDocs >= 20) {
      return Response.json({ error: '设备码申请过于频繁，请稍后再试' }, { status: 429 })
    }
  }

  const deviceCode = randomToken(40)
  const userCode = genUserCode()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  await payload.create({
    collection: 'device-codes',
    overrideAccess: true,
    data: {
      deviceCode,
      userCode,
      status: 'pending',
      meta: { runnerVersion: body.runnerVersion, os: body.os, arch: body.arch, label: body.label },
      ipHash: ipHashValue || undefined,
      expiresAt,
    },
  })

  const base = getServerUrl(runtimeEnv)
  return Response.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/device`,
    expires_in: 600,
    interval: 3,
  })
}
