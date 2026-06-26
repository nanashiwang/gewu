import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'

// POST /v1/bounties/{id}/submit  { skillSlug } —— 接单人提交交付的 Skill
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* noop */
  }
  const skillSlug = String(body.skillSlug || '').trim()
  if (!skillSlug) return Response.json({ error: '请提供交付的 Skill slug' }, { status: 400 })

  const b = await payload.findByID({ collection: 'bounties', id, overrideAccess: true }).catch(() => null)
  if (!b) return Response.json({ error: '悬赏不存在' }, { status: 404 })
  const acceptedById = typeof b.acceptedBy === 'object' ? (b.acceptedBy as any)?.id : b.acceptedBy
  if (acceptedById !== user.id) return Response.json({ error: '只有接单人可提交' }, { status: 403 })
  if (b.status !== 'accepted') return Response.json({ error: '当前状态不可提交' }, { status: 400 })

  const skills = await payload.find({
    collection: 'skills',
    where: { slug: { equals: skillSlug } },
    limit: 1,
    overrideAccess: true,
  })
  const skill = skills.docs[0]
  if (!skill) return Response.json({ error: 'Skill 不存在' }, { status: 404 })

  await payload.update({
    collection: 'bounties',
    id,
    data: { status: 'submitted', submittedSkill: skill.id },
    overrideAccess: true,
  })
  return Response.json({ ok: true })
}
