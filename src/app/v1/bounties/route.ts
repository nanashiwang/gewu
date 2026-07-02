import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'

// POST /v1/bounties —— 发布悬赏（幂等）
// 同一 idempotencyKey 只会创建一次：超时/断网后用户重试也不会重复发布/重复扣款。
// 扣款在 Bounties.afterChange 钩子内、与创建同一事务；扣款失败会回滚整个发布。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const { title, description, rewardPoints, dueAt, idempotencyKey } = body || {}
  if (!title || typeof title !== 'string') {
    return Response.json({ error: '请填写悬赏标题' }, { status: 400 })
  }

  // 幂等：该用户已用同一 key 发过 → 直接返回既有悬赏，不重复创建/扣款
  const findByKey = async () => {
    if (!idempotencyKey) return null
    const r = await payload.find({
      collection: 'bounties',
      where: {
        and: [{ creator: { equals: user.id } }, { idempotencyKey: { equals: idempotencyKey } }],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    return r.docs[0] || null
  }

  const existing = await findByKey()
  if (existing) return Response.json({ ok: true, id: existing.id, duplicate: true })

  try {
    const created = await payload.create({
      collection: 'bounties',
      data: {
        title,
        description: typeof description === 'string' ? description : undefined,
        rewardType: 'points',
        rewardPoints: Number(rewardPoints) || 0,
        status: 'open',
        dueAt: dueAt || undefined,
        creator: user.id,
        idempotencyKey: idempotencyKey || undefined,
      },
      overrideAccess: true,
    })
    return Response.json({ ok: true, id: created.id })
  } catch (e) {
    const msg = String((e as Error)?.message || e)
    // 并发下同一 key 撞唯一索引 → 回查返回既有（仍然幂等，不重复扣款）
    if (idempotencyKey && /idempotencyKey|duplicate|unique/i.test(msg)) {
      const again = await findByKey()
      if (again) return Response.json({ ok: true, id: again.id, duplicate: true })
    }
    // 余额不足由 beforeChange 抛出
    if (msg.includes('术值不足')) {
      return Response.json({ error: '术值不足，无法冻结赏金' }, { status: 400 })
    }
    payload.logger?.error(`发布悬赏失败: ${msg}`)
    return Response.json({ error: '发布失败，请重试' }, { status: 400 })
  }
}
