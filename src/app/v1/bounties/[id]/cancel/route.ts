import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { awardContribution } from '@/lib/contribution'

// POST /v1/bounties/{id}/cancel —— 发布人取消，退还冻结术值
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  const b = await payload.findByID({ collection: 'bounties', id, overrideAccess: true }).catch(() => null)
  if (!b) return Response.json({ error: '悬赏不存在' }, { status: 404 })
  const creatorId = typeof b.creator === 'object' ? (b.creator as any)?.id : b.creator
  if (creatorId !== user.id && user.role !== 'admin') {
    return Response.json({ error: '只有发布人可取消' }, { status: 403 })
  }
  if (['completed', 'cancelled'].includes(b.status as string)) {
    return Response.json({ error: '当前状态不可取消' }, { status: 400 })
  }

  await payload.update({ collection: 'bounties', id, data: { status: 'cancelled' }, overrideAccess: true })

  if ((b.frozenPoints || 0) > 0 && creatorId) {
    await awardContribution(payload, {
      userId: creatorId,
      actionType: 'other',
      points: b.frozenPoints || 0,
      relatedBounty: id,
      description: `退还悬赏赏金「${b.title}」`,
    })
  }
  return Response.json({ ok: true, refunded: b.frozenPoints || 0 })
}
