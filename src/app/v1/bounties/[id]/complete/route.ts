import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { awardContribution } from '@/lib/contribution'

// POST /v1/bounties/{id}/complete —— 发布人验收，释放冻结术值给接单人
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  const b = await payload.findByID({ collection: 'bounties', id, overrideAccess: true }).catch(() => null)
  if (!b) return Response.json({ error: '悬赏不存在' }, { status: 404 })
  const creatorId = typeof b.creator === 'object' ? (b.creator as any)?.id : b.creator
  if (creatorId !== user.id && user.role !== 'admin') {
    return Response.json({ error: '只有发布人可验收' }, { status: 403 })
  }
  if (b.status !== 'submitted') return Response.json({ error: '当前状态不可验收' }, { status: 400 })

  await payload.update({ collection: 'bounties', id, data: { status: 'completed' }, overrideAccess: true })

  const acceptedById = typeof b.acceptedBy === 'object' ? (b.acceptedBy as any)?.id : b.acceptedBy
  if ((b.frozenPoints || 0) > 0 && acceptedById) {
    // 释放冻结术值（无 'bounty' 规则 → 走传入 points 的可变金额）
    await awardContribution(payload, {
      userId: acceptedById,
      actionType: 'bounty',
      points: b.frozenPoints || 0,
      relatedBounty: id,
      description: `完成悬赏「${b.title}」奖励`,
    })
  }
  return Response.json({ ok: true, released: b.frozenPoints || 0 })
}
