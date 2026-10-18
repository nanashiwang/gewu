import { getPayload } from 'payload'
import config from '@payload-config'

export const dynamic = 'force-dynamic'

// 生产健康检查：验证 Next 进程与 Payload/Postgres 基本可用，不暴露业务数据。
export async function GET() {
  const startedAt = Date.now()
  try {
    const payload = await getPayload({ config })
    await payload.count({ collection: 'users', overrideAccess: true })
    return Response.json(
      { ok: true, db: true, latencyMs: Date.now() - startedAt,
        features: { reportOwnerGateway: process.env.GEWU_INTERNAL_API_TOKEN?.trim() ? 1 : 0 } },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    return Response.json(
      { ok: false, db: false, error: (e as Error).message.slice(0, 120) },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
