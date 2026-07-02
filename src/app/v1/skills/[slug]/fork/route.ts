import { getPayload } from 'payload'
import type { PayloadRequest } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { slugify } from '@/lib/slug'

// POST /v1/skills/{slug}/fork —— 从一个已发布 Skill 复制出自己的草稿版本(status pending 走审核)。
// 供给冷启动"从改一个现成的开始" + 记 forkedFrom 血统(变异-表现差分数据采集器)。
export async function POST(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  // 源 Skill：走 access（未发布/无权访问查不到），仅允许 fork 已发布
  const srcRes = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    limit: 1,
    depth: 0,
    overrideAccess: false,
    user,
  })
  const src = srcRes.docs[0] as any
  if (!src) return Response.json({ error: 'Skill 不存在或无权访问' }, { status: 404 })
  if (src.status !== 'published') return Response.json({ error: '只能 fork 已发布的 Skill' }, { status: 403 })

  // 源当前版本
  let srcVersion: any = src.currentVersion
  if (!srcVersion || typeof srcVersion === 'string') {
    const vs = await payload.find({
      collection: 'skill-versions',
      where: { skill: { equals: src.id } },
      sort: '-createdAt',
      limit: 1,
      overrideAccess: true,
    })
    srcVersion = vs.docs[0]
  }
  if (!srcVersion) return Response.json({ error: '源 Skill 暂无可用版本' }, { status: 400 })

  // 反刷：单作者待审存量上限（与发布端点一致）
  const pending = await payload.count({
    collection: 'skills',
    where: { and: [{ author: { equals: user.id } }, { status: { equals: 'pending' } }] },
    overrideAccess: true,
  })
  if (pending.totalDocs >= 20) {
    return Response.json({ error: '你有过多待审核的 Skill，请等审核后再 fork' }, { status: 429 })
  }

  // 复制 routePolicy 时剥离源的 dataDriven（那是源靠真实运行挣来的数据，fork 从零开始）
  let routePolicy = srcVersion.routePolicy
  if (routePolicy && typeof routePolicy === 'object') {
    const { dataDriven: _drop, ...rest } = routePolicy as any
    routePolicy = rest
  }

  let slugNew = slugify(`${src.title}-fork`)
  const exists = await payload.find({ collection: 'skills', where: { slug: { equals: slugNew } }, limit: 1, overrideAccess: true })
  if (exists.docs[0]) slugNew = `${slugNew}-${Math.random().toString(36).slice(2, 6)}`

  const transactionID = await payload.db.beginTransaction()
  const txReq: Partial<PayloadRequest> | undefined = transactionID ? { transactionID } : undefined
  try {
    const skill = await payload.create({
      collection: 'skills',
      overrideAccess: true,
      req: txReq,
      data: {
        title: `${src.title}（fork）`,
        slug: slugNew,
        description: src.description,
        category: src.category,
        author: user.id,
        forkedFrom: src.id,
        status: 'pending',
        visibility: 'public',
      },
    })
    await payload.create({
      collection: 'skill-versions',
      overrideAccess: true,
      req: txReq,
      data: {
        skill: skill.id,
        version: '1.0.0',
        systemPrompt: srcVersion.systemPrompt,
        promptTemplate: srcVersion.promptTemplate,
        inputSchema: srcVersion.inputSchema,
        outputSchema: srcVersion.outputSchema,
        recommendedModels: srcVersion.recommendedModels,
        routePolicy,
        examples: srcVersion.examples,
        license: srcVersion.license,
        permissions: srcVersion.permissions,
        changelog: `Fork 自「${src.title}」`,
        status: 'active',
        createdBy: user.id,
      },
    })
    if (transactionID) await payload.db.commitTransaction(transactionID)
    return Response.json({ ok: true, id: skill.id, slug: slugNew })
  } catch (e) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    payload.logger?.error(`fork Skill 失败: ${(e as Error).message}`)
    return Response.json({ error: 'fork 失败，请重试' }, { status: 400 })
  }
}
