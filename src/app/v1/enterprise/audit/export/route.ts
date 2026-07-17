import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { canReadEnterpriseAudit, exportEnterpriseAuditCsv } from '@/lib/enterprise'
import { boundedIntParam } from '@/lib/queryParams'
import { readEnterpriseQueryId } from '@/lib/enterpriseRequest'

// GET /v1/enterprise/audit/export?organizationId=... —— 企业运行审计 CSV 导出
export async function GET(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const url = new URL(request.url)
  const organizationId = readEnterpriseQueryId(url.searchParams, 'organizationId')
  if (typeof organizationId !== 'string') return Response.json({ error: organizationId.error }, { status: organizationId.status })
  const limit = boundedIntParam(url.searchParams, 'limit', 1000, 1, 5000)
  const access = await canReadEnterpriseAudit(payload, {
    userId: user.id as string,
    userRole: (user as any).role,
    organizationId,
  })
  if (!access.ok) return Response.json({ error: access.reason }, { status: 403 })

  const csv = await exportEnterpriseAuditCsv(payload, { organizationId, limit })
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="gewu-enterprise-audit-${organizationId}.csv"`,
    },
  })
}
