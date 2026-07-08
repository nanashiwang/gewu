import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { ADAPTER_REVIEWER_ROLES, normalizeAdapterReviewRequest, reviewAdapters } from '@/lib/adapterReview'
import { readJsonBodyWithLimit } from '@/lib/requestBody'

const MAX_ADAPTER_REVIEW_BYTES = 50_000

// POST /v1/adapters/review —— 审核员批量更新 Adapter 人工评审状态；批准时可批量启用 active。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })
  if (!ADAPTER_REVIEWER_ROLES.has(String((user as any).role || ''))) {
    return Response.json({ error: '只有审核员可以批量评审 Adapter' }, { status: 403 })
  }

  const parsed = await readJsonBodyWithLimit(request, MAX_ADAPTER_REVIEW_BYTES, 'Adapter 批量评审请求体过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const normalized = normalizeAdapterReviewRequest(parsed.value)
  if (!normalized.ok) return Response.json({ error: normalized.reason }, { status: 400 })

  const result = await reviewAdapters(payload, normalized)
  return Response.json(result, { status: result.failed ? 207 : 200 })
}
