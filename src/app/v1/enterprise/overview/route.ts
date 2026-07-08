import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { readEnterpriseQueryId } from '@/lib/enterpriseRequest'
import { boundedIntParam } from '@/lib/queryParams'
import { getEnterpriseGovernanceOverview } from '@/lib/enterpriseOverview'

// GET /v1/enterprise/overview?organizationId=... —— 企业治理总览：准入、重审、身份、审计和失败库摘要。
export async function GET(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const url = new URL(request.url)
  const organizationId = readEnterpriseQueryId(url.searchParams, 'organizationId')
  if (typeof organizationId !== 'string') return Response.json({ error: organizationId.error }, { status: organizationId.status })
  const auditLimit = boundedIntParam(url.searchParams, 'auditLimit', 200, 1, 1000)
  const failureLimit = boundedIntParam(url.searchParams, 'failureLimit', 1000, 1, 5000)

  const result = await getEnterpriseGovernanceOverview(payload, {
    actorId: user.id as string,
    actorRole: (user as any).role,
    organizationId,
    auditLimit,
    failureLimit,
  })
  if (!result.ok) return Response.json({ error: result.reason }, { status: 403 })
  return Response.json(result)
}
