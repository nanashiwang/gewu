import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { ADAPTER_REVIEWER_ROLES, normalizeAdapterReviewRequest, reviewAdapters } from '@/lib/adapterReview'
import { readJsonBodyWithLimit } from '@/lib/requestBody'

const MAX_ADAPTER_REVIEW_BYTES = 20_000

// POST /v1/adapters/{id}/review —— 审核员更新 Adapter 人工评审状态；批准时可同时启用 active。
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })
  if (!ADAPTER_REVIEWER_ROLES.has(String((user as any).role || ''))) {
    return Response.json({ error: '只有审核员可以评审 Adapter' }, { status: 403 })
  }

  const parsed = await readJsonBodyWithLimit(request, MAX_ADAPTER_REVIEW_BYTES, 'Adapter 评审请求体过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const normalized = normalizeAdapterReviewRequest({ ...(parsed.value as any), id })
  if (!normalized.ok) return Response.json({ error: normalized.reason }, { status: 400 })
  const result = await reviewAdapters(payload, normalized)
  const row = result.results[0]
  if (!row?.ok && row?.error === 'Adapter 不存在') return Response.json({ error: row.error }, { status: 404 })
  if (!row?.ok) return Response.json({ error: row?.error || '更新失败' }, { status: 400 })

  return Response.json({
    ok: true,
    adapter: {
      id: row.id,
      status: row.status || 'draft',
      reviewStatus: row.reviewStatus || normalized.reviewStatus,
      reviewedAt: row.reviewedAt || null,
    },
  })
}
