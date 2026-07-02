import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { anonHash } from '@/lib/compat'

// POST /v1/reports/{id}/handle  { action, note? } —— 审核员/管理员处置举报（封禁闭环）。
// action: dismiss(驳回) | resolve(标记已解决) | ban_target(封禁责任用户) | hide_target(隐藏内容)
const STAFF = ['admin', 'reviewer']

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if (!STAFF.includes(user.role as string)) return Response.json({ error: '无权处置' }, { status: 403 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* 容忍空 body */
  }
  const action = String(body.action || '')
  if (!['dismiss', 'resolve', 'ban_target', 'hide_target'].includes(action)) {
    return Response.json({ error: '无效的处置动作' }, { status: 400 })
  }

  const report = await payload.findByID({ collection: 'reports', id, depth: 0, overrideAccess: true }).catch(() => null)
  if (!report) return Response.json({ error: '举报不存在' }, { status: 404 })
  const targetType = (report as any).targetType
  const targetId = (report as any).targetId

  try {
    // 定位责任用户 / 内容
    async function resolveOwnerUserId(): Promise<string | null> {
      if (targetType === 'user') return targetId
      const coll = targetType === 'skill' ? 'skills' : targetType === 'review' ? 'reviews' : targetType === 'bounty' ? 'bounties' : null
      if (!coll) return null
      const doc = await payload.findByID({ collection: coll as any, id: targetId, depth: 0, overrideAccess: true }).catch(() => null)
      if (!doc) return null
      const ownerField = targetType === 'skill' ? 'author' : targetType === 'bounty' ? 'creator' : 'user'
      const ref = (doc as any)[ownerField]
      return typeof ref === 'object' ? ref?.id : ref
    }

    if (action === 'ban_target') {
      const ownerId = await resolveOwnerUserId()
      if (!ownerId) return Response.json({ error: '无法定位责任用户' }, { status: 400 })
      if (String(ownerId) === String(user.id)) return Response.json({ error: '不能封禁自己' }, { status: 400 })
      await payload.update({ collection: 'users', id: ownerId, data: { accountStatus: 'banned' }, overrideAccess: true })
      // 追溯降权：抑制该用户历史 online 兼容报告(anonHash 匹配)，权重归 0 不再影响 LocalScore/榜(6e 残余收口)
      try {
        await payload.update({
          collection: 'compat-reports',
          where: { and: [{ anonymousUserHash: { equals: anonHash(String(ownerId)) } }, { source: { equals: 'online' } }] },
          data: { suppressed: true },
          overrideAccess: true,
        })
      } catch (e) {
        payload.logger?.error(`抑制被封用户报告失败: ${(e as Error).message}`)
      }
    } else if (action === 'hide_target') {
      if (targetType === 'skill') {
        await payload.update({ collection: 'skills', id: targetId, data: { status: 'archived' }, overrideAccess: true }).catch(() => null)
      } else if (targetType === 'review') {
        await payload.update({ collection: 'reviews', id: targetId, data: { status: 'hidden' }, overrideAccess: true }).catch(() => null)
      } else {
        return Response.json({ error: '该对象类型不支持隐藏' }, { status: 400 })
      }
    }

    const newStatus = action === 'dismiss' ? 'dismissed' : 'resolved'
    await payload.update({
      collection: 'reports',
      id,
      data: { status: newStatus, handledBy: user.id, detail: body.note ? `${(report as any).detail || ''}\n[处置] ${body.note}`.slice(0, 2000) : (report as any).detail },
      overrideAccess: true,
    })
    return Response.json({ ok: true, status: newStatus })
  } catch (e) {
    payload.logger?.error(`处置举报失败: ${(e as Error).message}`)
    return Response.json({ error: '处置失败，请重试' }, { status: 500 })
  }
}
