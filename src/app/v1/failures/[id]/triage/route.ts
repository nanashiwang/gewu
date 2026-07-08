import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { readJsonBodyWithLimit } from '@/lib/requestBody'

const TRIAGE_STATUSES = new Set(['pending', 'attributed', 'needs_more_evidence', 'verified'])
const ROOT_CAUSES = new Set(['model_drift', 'prompt_boundary', 'schema_mismatch', 'adapter_gap', 'data_quality', 'unknown'])
const REVIEWER_ROLES = new Set(['admin', 'reviewer'])
const MAX_FAILURE_TRIAGE_BYTES = 30_000

function cleanCoverage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const key of ['targetRuns', 'verifiedRuns', 'beforeSuccessRate', 'afterSuccessRate', 'formatRateAfter']) {
    const n = Number(input[key])
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}

// POST /v1/failures/{id}/triage —— 审核员为失败案例写入人工归因与复验覆盖。
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })
  if (!REVIEWER_ROLES.has(String((user as any).role || ''))) return Response.json({ error: '只有审核员可以归因失败案例' }, { status: 403 })

  const parsed = await readJsonBodyWithLimit(request, MAX_FAILURE_TRIAGE_BYTES, '失败归因请求体过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const body = parsed.value && typeof parsed.value === 'object' ? parsed.value as any : {}
  const triageStatus = String(body.triageStatus || '').trim()
  if (!TRIAGE_STATUSES.has(triageStatus)) return Response.json({ error: 'triageStatus 不合法' }, { status: 400 })
  const rootCauseCategory = body.rootCauseCategory ? String(body.rootCauseCategory).trim() : undefined
  if (rootCauseCategory && !ROOT_CAUSES.has(rootCauseCategory)) return Response.json({ error: 'rootCauseCategory 不合法' }, { status: 400 })
  const triageNotes = typeof body.triageNotes === 'string' ? body.triageNotes.trim().slice(0, 1000) : undefined
  const verificationCoverage = cleanCoverage(body.verificationCoverage)

  const failure = await payload.findByID({ collection: 'failure-cases' as any, id, depth: 0, overrideAccess: true }).catch(() => null)
  if (!failure) return Response.json({ error: '失败案例不存在' }, { status: 404 })

  const updated = await payload.update({
    collection: 'failure-cases' as any,
    id,
    data: {
      triageStatus,
      ...(rootCauseCategory ? { rootCauseCategory } : {}),
      ...(triageNotes ? { triageNotes } : {}),
      ...(verificationCoverage ? { verificationCoverage } : {}),
    },
    depth: 0,
    overrideAccess: true,
  })

  return Response.json({
    ok: true,
    failure: {
      id: String((updated as any).id || ''),
      triageStatus: (updated as any).triageStatus || triageStatus,
      rootCauseCategory: (updated as any).rootCauseCategory || rootCauseCategory || null,
      triagedAt: (updated as any).triagedAt || null,
    },
  })
}
