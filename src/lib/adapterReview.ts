import type { Payload } from 'payload'

export const ADAPTER_REVIEW_STATUSES = new Set(['pending', 'needs_changes', 'approved', 'rejected'])
export const ADAPTER_REVIEWER_ROLES = new Set(['admin', 'reviewer'])

export type AdapterReviewStatus = 'pending' | 'needs_changes' | 'approved' | 'rejected'

export function normalizeAdapterReviewRequest(body: any):
  | { ok: true; ids: string[]; reviewStatus: AdapterReviewStatus; activate: boolean; reviewerNotes?: string }
  | { ok: false; reason: string } {
  const ids = (Array.isArray(body?.ids) ? body.ids : body?.id ? [body.id] : [])
    .map((id: unknown) => String(id || '').trim())
    .filter(Boolean)
  const uniqueIds = [...new Set(ids)] as string[]
  const limitedIds = uniqueIds.slice(0, 100)
  if (!limitedIds.length) return { ok: false, reason: '缺少 Adapter ids' }
  const reviewStatus = String(body?.reviewStatus || '').trim() as AdapterReviewStatus
  if (!ADAPTER_REVIEW_STATUSES.has(reviewStatus)) return { ok: false, reason: 'reviewStatus 不合法' }
  const activate = Boolean(body?.activate)
  if (activate && reviewStatus !== 'approved') return { ok: false, reason: '只有 approved 可以启用 Adapter' }
  const reviewerNotes = typeof body?.reviewerNotes === 'string' ? body.reviewerNotes.trim().slice(0, 1000) : undefined
  return { ok: true, ids: limitedIds, reviewStatus, activate, reviewerNotes }
}

export async function reviewAdapters(
  payload: Payload,
  args: { ids: string[]; reviewStatus: AdapterReviewStatus; activate?: boolean; reviewerNotes?: string },
) {
  const results: Array<{ id: string; ok: boolean; status?: string; reviewStatus?: string; reviewedAt?: string | null; error?: string }> = []
  for (const id of args.ids) {
    const adapter = await payload.findByID({ collection: 'adapter-profiles' as any, id, depth: 0, overrideAccess: true }).catch(() => null) as any
    if (!adapter) {
      results.push({ id, ok: false, error: 'Adapter 不存在' })
      continue
    }
    try {
      const updated = await payload.update({
        collection: 'adapter-profiles' as any,
        id,
        data: {
          reviewStatus: args.reviewStatus,
          ...(args.reviewerNotes ? { reviewerNotes: args.reviewerNotes } : {}),
          ...(args.activate ? { status: 'active' } : args.reviewStatus === 'rejected' ? { status: 'disabled' } : {}),
        },
        depth: 0,
        overrideAccess: true,
      }) as any
      results.push({
        id,
        ok: true,
        status: updated.status || 'draft',
        reviewStatus: updated.reviewStatus || args.reviewStatus,
        reviewedAt: updated.reviewedAt || null,
      })
    } catch (e) {
      results.push({ id, ok: false, error: (e as Error).message })
    }
  }
  const approved = results.filter((r) => r.ok && r.reviewStatus === 'approved').length
  const failed = results.filter((r) => !r.ok).length
  return {
    ok: failed === 0,
    total: results.length,
    updated: results.length - failed,
    approved,
    failed,
    results,
    customerValue: '审核员可一次性处理多个 Adapter 草稿，减少失败库修复建议堆积，并保留每条补丁的审核门禁。',
  }
}
