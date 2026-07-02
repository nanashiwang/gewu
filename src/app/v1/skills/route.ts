import { getPayload } from 'payload'
import type { PayloadRequest } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { slugify } from '@/lib/slug'

// POST /v1/skills —— 创作者发布 Skill（创建 Skill + 首个版本，状态 pending 走审核）。
// 放开给任意登录用户：提交进 pending，由审核员/管理员审核后 published。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '请求体无效' }, { status: 400 })
  }
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const promptTemplate = typeof body.promptTemplate === 'string' ? body.promptTemplate.trim() : ''
  if (!title) return Response.json({ error: '请填写 Skill 名称' }, { status: 400 })
  if (!promptTemplate) return Response.json({ error: '请填写 User 模板' }, { status: 400 })

  // 可选 JSON 字段解析（非法则拒绝，避免脏数据入库）
  const parseJson = (s: unknown): { ok: true; value: any } | { ok: false } => {
    if (s == null || s === '') return { ok: true, value: undefined }
    if (typeof s !== 'string') return { ok: true, value: s }
    try {
      return { ok: true, value: JSON.parse(s) }
    } catch {
      return { ok: false }
    }
  }
  const inputParsed = parseJson(body.inputSchema)
  if (!inputParsed.ok) return Response.json({ error: '输入字段定义不是合法 JSON' }, { status: 400 })
  const modelsParsed = parseJson(body.recommendedModels)
  if (!modelsParsed.ok) return Response.json({ error: '推荐模型不是合法 JSON' }, { status: 400 })

  // 分类（可选，按 slug 解析）
  let categoryId: string | undefined
  if (typeof body.categorySlug === 'string' && body.categorySlug) {
    const cats = await payload.find({
      collection: 'categories',
      where: { slug: { equals: body.categorySlug } },
      limit: 1,
      overrideAccess: true,
    })
    categoryId = cats.docs[0]?.id as string | undefined
  }

  // 反刷：单作者待审存量上限，防脚本灌垃圾撑审核队列/撑大 DB
  const pending = await payload.count({
    collection: 'skills',
    where: { and: [{ author: { equals: user.id } }, { status: { equals: 'pending' } }] },
    overrideAccess: true,
  })
  if (pending.totalDocs >= 20) {
    return Response.json({ error: '你有过多待审核的 Skill，请等审核后再提交' }, { status: 429 })
  }

  // slug 唯一：碰撞则加短后缀（唯一约束在 Skills.slug 兜底并发）
  let slug = slugify(title)
  const exists = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    limit: 1,
    overrideAccess: true,
  })
  if (exists.docs[0]) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`

  // 原子：Skill + 首版本 绑同一事务；版本 afterChange 会自动设 skill.currentVersion
  const transactionID = await payload.db.beginTransaction()
  const txReq: Partial<PayloadRequest> | undefined = transactionID ? { transactionID } : undefined
  try {
    const skill = await payload.create({
      collection: 'skills',
      overrideAccess: true,
      req: txReq,
      data: {
        title,
        slug,
        description: typeof body.description === 'string' ? body.description : undefined,
        category: categoryId,
        author: user.id,
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
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
        promptTemplate,
        inputSchema: inputParsed.value,
        recommendedModels: modelsParsed.value,
        status: 'active',
        createdBy: user.id,
      },
    })
    if (transactionID) await payload.db.commitTransaction(transactionID)
    return Response.json({ ok: true, id: skill.id, slug })
  } catch (e) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    payload.logger?.error(`发布 Skill 失败: ${(e as Error).message}`)
    return Response.json({ error: '发布失败，请重试' }, { status: 400 })
  }
}
