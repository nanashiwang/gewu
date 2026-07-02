import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { runSkill } from '@/lib/skillRunner'

const MAX_MODELS = 4

// POST /v1/skills/{slug}/compare —— 多模型对比：同一输入并行跑多个模型
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const payload = await getPayload({ config })

  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* 容忍空 body */
  }
  const input: Record<string, unknown> = body.input || {}
  let models: string[] = Array.isArray(body.models) ? body.models.filter(Boolean) : []
  models = [...new Set(models)].slice(0, MAX_MODELS) // 去重 + 限制数量
  if (models.length === 0) {
    return Response.json({ error: '请至少选择一个模型' }, { status: 400 })
  }

  // 查 Skill（强制 access）
  const skills = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    limit: 1,
    depth: 1,
    overrideAccess: false,
    user,
  })
  const skill = skills.docs[0]
  if (!skill) return Response.json({ error: 'Skill 不存在或无权访问' }, { status: 404 })
  if (skill.status !== 'published') {
    return Response.json({ error: 'Skill 未发布' }, { status: 403 })
  }

  // 当前版本
  let version: any = skill.currentVersion
  if (typeof version === 'string') {
    version = await payload
      .findByID({ collection: 'skill-versions', id: version, overrideAccess: true })
      .catch(() => null)
  }
  if (!version) {
    const vs = await payload.find({
      collection: 'skill-versions',
      where: { skill: { equals: skill.id } },
      sort: '-createdAt',
      limit: 1,
      overrideAccess: true,
    })
    version = vs.docs[0]
  }
  if (!version) return Response.json({ error: 'Skill 暂无可用版本' }, { status: 400 })

  const fullUser = await payload
    .findByID({ collection: 'users', id: user.id, overrideAccess: true, depth: 0 })
    .catch(() => null)
  const userApiKey = (fullUser as any)?.newapiKeyEncrypted || undefined

  // 串行跑各模型（forceModel 固定模型、skipAggregate 不污染聚合指标）。
  // 刻意串行而非并行：让每个 runSkill 看到前一个已扣减的 credit 余额与已落库的频控计数，
  // 消除平台代付下"同一余额被多个并发预检共用"的 TOCTOU 白嫖与频控击穿（对抗审查 P0/P1）。
  const results: any[] = []
  for (const m of models) {
    try {
      const r = await runSkill({
        payload,
        skill,
        version,
        input,
        user: { id: user.id as string },
        userApiKey,
        forceModel: m,
        skipAggregate: true,
      })
      results.push({ model: m, ...r })
    } catch (e) {
      results.push({ model: m, ok: false, runId: '', errors: [(e as Error).message] })
    }
  }

  return Response.json({ results })
}
