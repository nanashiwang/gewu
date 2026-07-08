import { describe, expect, it } from 'vitest'
import { normalizeAdapterReviewRequest, reviewAdapters } from '@/lib/adapterReview'

describe('adapterReview — Adapter 批量评审', () => {
  it('规范化批量评审请求并限制最多 100 个去重 ID', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `adapter-${i % 110}`)
    const req = normalizeAdapterReviewRequest({
      ids,
      reviewStatus: 'approved',
      activate: true,
      reviewerNotes: 'x'.repeat(1200),
    })

    expect(req).toMatchObject({ ok: true, reviewStatus: 'approved', activate: true })
    if (req.ok) {
      expect(req.ids).toHaveLength(100)
      expect(req.reviewerNotes).toHaveLength(1000)
    }
    expect(normalizeAdapterReviewRequest({ ids: ['a'], reviewStatus: 'rejected', activate: true })).toEqual({
      ok: false,
      reason: '只有 approved 可以启用 Adapter',
    })
  })

  it('批量批准时逐条启用，并返回部分失败结果', async () => {
    const updates: any[] = []
    const payload = {
      findByID: async ({ id }: any) => (id === 'missing' ? null : { id, status: 'draft', reviewStatus: 'pending' }),
      update: async (args: any) => {
        updates.push(args)
        return { id: args.id, ...args.data, reviewedAt: '2026-07-08T00:00:00.000Z' }
      },
    }

    const result = await reviewAdapters(payload as any, {
      ids: ['a1', 'missing', 'a2'],
      reviewStatus: 'approved',
      activate: true,
      reviewerNotes: '批量确认',
    })

    expect(result).toMatchObject({
      ok: false,
      total: 3,
      updated: 2,
      approved: 2,
      failed: 1,
      customerValue: expect.stringContaining('一次性处理多个 Adapter'),
    })
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({
      collection: 'adapter-profiles',
      id: 'a1',
      data: { reviewStatus: 'approved', status: 'active', reviewerNotes: '批量确认' },
    })
    expect(result.results).toContainEqual({ id: 'missing', ok: false, error: 'Adapter 不存在' })
  })
})
