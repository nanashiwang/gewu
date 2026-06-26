import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'

// POST /v1/bounties/{id}/accept —— 创作者认领悬赏
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  const b = await payload.findByID({ collection: 'bounties', id, overrideAccess: true }).catch(() => null)
  if (!b) return Response.json({ error: '悬赏不存在' }, { status: 404 })
  const creatorId = typeof b.creator === 'object' ? (b.creator as any)?.id : b.creator
  if (creatorId === user.id) return Response.json({ error: '不能认领自己的悬赏' }, { status: 400 })
  if (b.status !== 'open') return Response.json({ error: '悬赏当前不可认领' }, { status: 400 })

  await payload.update({
    collection: 'bounties',
    id,
    data: { status: 'accepted', acceptedBy: user.id },
    overrideAccess: true,
  })
  return Response.json({ ok: true })
}
