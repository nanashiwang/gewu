import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { runSkill } from '@/lib/skillRunner'
import type { RouteMode } from '@/lib/constants'

// POST /v1/skills/{slug}/run —— 对外运行端点（产品文档 §3.3）
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const payload = await getPayload({ config })

  // 鉴权
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* 空 body 容忍 */
  }
  const input: Record<string, unknown> = body.input || {}
  const routeMode: RouteMode | undefined = body.routeMode

  // 查 Skill（强制 access：未发布/无权访问将查不到）
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

  // 解析当前版本（depth:1 已尽量 populate）
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

  // 用户绑定的 模型网关 Key（可选，优先于全局）
  const fullUser = await payload
    .findByID({ collection: 'users', id: user.id, overrideAccess: true, depth: 0 })
    .catch(() => null)
  const userApiKey = (fullUser as any)?.newapiKeyEncrypted || undefined

  const result = await runSkill({
    payload,
    skill,
    version,
    input,
    user: { id: user.id as string },
    routeMode,
    userApiKey,
  })

  // 护栏错误码 → HTTP 状态（余额不足 402 / 需 BYOK 403 / 频控 429）
  const status = result.ok
    ? 200
    : result.errorCode === 'INSUFFICIENT_CREDIT'
      ? 402
      : result.errorCode === 'MODEL_REQUIRES_BYOK'
        ? 403
        : result.errorCode === 'RATE_LIMITED'
          ? 429
          : 422
  return Response.json(result, { status })
}
