import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { isPublicFailureCase } from '@/lib/failureCasePublic'
import { buildApprovedAdapterWhere, buildFailureReverifyRunWhere, buildFailureReverifyPlan } from '@/lib/reverifyPlan'
import { enqueueReverifyJob } from '@/lib/reverifyQueue'

function relationId(value: any) {
  if (!value) return null
  return typeof value === 'object' ? String(value.id || '') || null : String(value)
}

function canViewFailureCase(user: any, failure: any) {
  if (isPublicFailureCase(failure)) return true
  const role = String(user?.role || '')
  if (role === 'admin' || role === 'reviewer') return true
  const authorId = relationId(failure?.skill?.author)
  return authorId && String(authorId) === String(user?.id)
}

// POST /v1/failures/{id}/reverify-queue —— 把私人台账复验计划放入批量队列。
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const failureCase = await payload.findByID({ collection: 'failure-cases' as any, id, depth: 2, overrideAccess: true }).catch(() => null)
  if (!failureCase) return Response.json({ error: '失败案例不存在' }, { status: 404 })
  if (!canViewFailureCase(user, failureCase)) return Response.json({ error: '无权查看该失败案例' }, { status: 403 })

  const [runsRes, adaptersRes] = await Promise.all([
    payload.find({
      collection: 'skill-runs' as any,
      where: buildFailureReverifyRunWhere(String(user.id), failureCase),
      depth: 0,
      limit: 20,
      sort: '-createdAt',
      overrideAccess: true,
    }).catch(() => ({ docs: [] as any[] })),
    payload.find({
      collection: 'adapter-profiles' as any,
      where: buildApprovedAdapterWhere(failureCase),
      depth: 0,
      limit: 10,
      sort: '-liftScore',
      overrideAccess: true,
    }).catch(() => ({ docs: [] as any[] })),
  ])

  const candidateRunIds = (runsRes.docs as any[]).map((run) => String(run.id || '')).filter(Boolean)
  const adapterIds = (adaptersRes.docs as any[]).map((adapter) => String(adapter.id || '')).filter(Boolean)
  const queued = await enqueueReverifyJob(payload, {
    failureCaseId: String(id),
    userId: String(user.id),
    candidateRunIds,
    adapterIds,
    reason: 'manual',
  })

  return Response.json({
    ok: queued.enqueued,
    queued,
    plan: buildFailureReverifyPlan({ failureCase, candidateRuns: runsRes.docs as any[], adapters: adaptersRes.docs as any[], userId: String(user.id) }),
    jobPreview: { failureCaseId: String(id), candidateRunIds, adapterIds },
  }, { status: queued.enqueued ? 200 : queued.skipped === 'redis_not_configured' ? 503 : 202 })
}
