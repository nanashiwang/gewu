import { getPayload } from 'payload'
import type { Payload, PayloadRequest } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { slugify } from '@/lib/slug'
import { normalizeSkillSubmissionKey } from '@/lib/skillSubmission'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'
import { notify } from '@/lib/notify'
import {
  analyzeSkillPackage,
  packageStatusForReview,
  reviewSkillPackage,
  reviewToChangelog,
  storeSkillPackage,
} from '@/lib/skillPackage'

type SkillVisibility = 'public' | 'private' | 'unlisted' | 'enterprise'

// POST /v1/skills —— 创作者发布 Skill。
// JSON：兼容旧的 Prompt 表单；multipart/form-data：新 Skill 包上传 + 规则/AI 自动审核。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    return handlePackageSubmission(payload, request, user as any)
  }
  return handlePromptSubmission(payload, request, user as any)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function resolveCategory(payload: Payload, categorySlug: string) {
  if (!categorySlug) return { id: undefined as string | undefined, name: '' }
  const cats = await payload.find({
    collection: 'categories',
    where: { slug: { equals: categorySlug } },
    limit: 1,
    overrideAccess: true,
  })
  const cat = cats.docs[0] as any
  return { id: cat?.id as string | undefined, name: cat?.name ? String(cat.name) : categorySlug }
}

async function ensurePendingQuota(payload: Payload, userId: string) {
  const pending = await payload.count({
    collection: 'skills',
    where: { and: [{ author: { equals: userId } }, { status: { equals: 'pending' } }] },
    overrideAccess: true,
  })
  return pending.totalDocs < 20
}

async function findIdempotentSkill(payload: Payload, userId: string, idempotencyKey: string | undefined) {
  if (!idempotencyKey) return null
  const existing = await payload.find({
    collection: 'skills',
    where: { and: [{ author: { equals: userId } }, { clientSubmissionKey: { equals: idempotencyKey } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return existing.docs[0] as any
}

async function notifySkillReviewers(payload: Payload, skill: any, review: any, actorId: string) {
  const staff = await payload.find({
    collection: 'users',
    where: {
      and: [
        { accountStatus: { equals: 'active' } },
        { or: [{ role: { equals: 'admin' } }, { role: { equals: 'reviewer' } }] },
      ],
    },
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })
  await Promise.all(
    (staff.docs as any[]).map((u) =>
      notify(payload, {
        userId: String(u.id),
        type: 'system',
        title: `Skill「${skill.title}」需要人工审核`,
        body: review?.summary || 'AI 审核未直接通过，请管理员进一步确认。',
        link: '/console/admin/skills',
        relatedSkill: String(skill.id),
        actorId,
      }),
    ),
  )
}

function uniqueSlug(base: string) {
  return `${base}-${Math.random().toString(36).slice(2, 6)}`
}

async function createUniqueSlug(payload: Payload, title: string) {
  let slug = slugify(title)
  const exists = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    limit: 1,
    overrideAccess: true,
  })
  if (exists.docs[0]) slug = uniqueSlug(slug)
  return slug
}

function parseJson(s: unknown): { ok: true; value: any } | { ok: false } {
  if (s == null || s === '') return { ok: true, value: undefined }
  if (typeof s !== 'string') return { ok: true, value: s }
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

function normalizeModels(models: any) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return models
  if (models.cloud || models.local) return models
  const out: Record<string, unknown> = { ...models }
  if (Array.isArray(models.cloud_recommended)) out.cloud = models.cloud_recommended
  if (Array.isArray(models.local_recommended)) out.local = models.local_recommended
  return out
}

async function handlePackageSubmission(payload: Payload, request: Request, user: any) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return Response.json({ error: '表单数据无效' }, { status: 400 })
  }

  const title = readString(form.get('title'))
  const description = readString(form.get('description'))
  const categorySlug = readString(form.get('categorySlug'))
  const visibilityRaw = readString(form.get('visibility'))
  const visibility: SkillVisibility = ['public', 'private', 'unlisted', 'enterprise'].includes(visibilityRaw)
    ? (visibilityRaw as SkillVisibility)
    : 'public'
  const idempotencyKey = normalizeSkillSubmissionKey(form.get('idempotencyKey') || request.headers.get('Idempotency-Key'))
  if (!title) return Response.json({ error: '请填写 Skill 名称' }, { status: 400 })

  const existing = await findIdempotentSkill(payload, user.id, idempotencyKey)
  if (existing) return Response.json({ ok: true, id: existing.id, slug: existing.slug, status: existing.status, idempotent: true })

  if (!(await ensurePendingQuota(payload, user.id))) {
    return Response.json({ error: '你有过多待审核的 Skill，请等审核后再提交' }, { status: 429 })
  }

  const upload = form.get('skillPackage') as any
  if (!upload || typeof upload.arrayBuffer !== 'function') {
    return Response.json({ error: '请上传 Skill 压缩包' }, { status: 400 })
  }
  const fileName = typeof upload.name === 'string' ? upload.name : 'skill-package.zip'
  const buffer = Buffer.from(await upload.arrayBuffer())

  let analysis: ReturnType<typeof analyzeSkillPackage>
  try {
    analysis = analyzeSkillPackage(fileName, buffer)
  } catch (e) {
    return Response.json({ error: (e as Error).message || 'Skill 包解析失败' }, { status: 400 })
  }
  const blocker = analysis.issues.find((i) => i.level === 'blocker')
  if (blocker) {
    return Response.json({ error: blocker.message, code: blocker.code, issues: analysis.issues }, { status: 400 })
  }

  const category = await resolveCategory(payload, categorySlug)
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const review = await reviewSkillPackage({ title, category: category.name, description, analysis, env: runtimeEnv })
  const status = packageStatusForReview(review)
  const slug = await createUniqueSlug(payload, title)
  const promptTemplate =
    analysis.promptTemplate ||
    `这是一个 Skill 包「${title}」。当前在线试用仅自动支持 Prompt Skill；请下载 Skill 包后使用本地 Runner 按包内 README 与 hengshu.skill.yaml 执行。`

  const transactionID = await payload.db.beginTransaction()
  const txReq: Partial<PayloadRequest> | undefined = transactionID ? { transactionID } : undefined
  let skill: any
  let version: any
  try {
    skill = await payload.create({
      collection: 'skills',
      overrideAccess: true,
      req: txReq,
      data: {
        title,
        slug,
        description: description || analysis.manifest?.description || analysis.readmeText?.slice(0, 220) || undefined,
        category: category.id,
        author: user.id,
        clientSubmissionKey: idempotencyKey || undefined,
        status,
        visibility,
      },
    })
    version = await payload.create({
      collection: 'skill-versions',
      overrideAccess: true,
      req: txReq,
      data: {
        skill: skill.id,
        version: analysis.version || '1.0.0',
        systemPrompt: analysis.systemPrompt,
        promptTemplate,
        inputSchema: analysis.inputSchema,
        outputSchema: analysis.outputSchema,
        recommendedModels: normalizeModels(analysis.recommendedModels),
        routePolicy: analysis.routePolicy,
        examples: analysis.examples,
        license: analysis.license,
        minRunnerVersion: analysis.minRunnerVersion,
        permissions: analysis.permissions,
        changelog: reviewToChangelog(review, analysis),
        status: 'active',
        createdBy: user.id,
      },
    })
    if (transactionID) await payload.db.commitTransaction(transactionID)
  } catch (e) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    const doc = await findIdempotentSkill(payload, user.id, idempotencyKey)
    if (doc) return Response.json({ ok: true, id: doc.id, slug: doc.slug, status: doc.status, idempotent: true })
    payload.logger?.error(`发布 Skill 包失败: ${(e as Error).message}`)
    return Response.json({ error: '发布失败，请重试' }, { status: 400 })
  }

  try {
    await storeSkillPackage({ skillId: skill.id, versionId: version.id, analysis, buffer })
  } catch (e) {
    await payload.update({ collection: 'skills', id: skill.id, data: { status: 'pending' }, overrideAccess: true }).catch(() => null)
    payload.logger?.error(`保存 Skill 包失败: ${(e as Error).message}`)
    return Response.json({ error: 'Skill 已保存但包文件落盘失败，请联系管理员处理' }, { status: 500 })
  }

  if (status === 'pending') {
    notifySkillReviewers(payload, skill, review, user.id).catch((e) =>
      payload.logger?.error(`Skill 待审通知失败: ${(e as Error).message}`),
    )
  }

  return Response.json({
    ok: true,
    id: skill.id,
    slug,
    status,
    autoPublished: status === 'published',
    requiresHumanReview: status === 'pending',
    review: {
      decision: review.decision,
      riskLevel: review.riskLevel,
      summary: review.summary,
      findings: review.findings,
      reviewedBy: review.reviewedBy,
    },
  })
}

async function handlePromptSubmission(payload: Payload, request: Request, user: any) {
  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '请求体无效' }, { status: 400 })
  }
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const promptTemplate = typeof body.promptTemplate === 'string' ? body.promptTemplate.trim() : ''
  const idempotencyKey = normalizeSkillSubmissionKey(body.idempotencyKey || request.headers.get('Idempotency-Key'))
  if (!title) return Response.json({ error: '请填写 Skill 名称' }, { status: 400 })
  if (!promptTemplate) return Response.json({ error: '请填写 User 模板' }, { status: 400 })

  const existing = await findIdempotentSkill(payload, user.id, idempotencyKey)
  if (existing) return Response.json({ ok: true, id: existing.id, slug: existing.slug, idempotent: true })

  const inputParsed = parseJson(body.inputSchema)
  if (!inputParsed.ok) return Response.json({ error: '输入字段定义不是合法 JSON' }, { status: 400 })
  const modelsParsed = parseJson(body.recommendedModels)
  if (!modelsParsed.ok) return Response.json({ error: '推荐模型不是合法 JSON' }, { status: 400 })

  const category = await resolveCategory(payload, typeof body.categorySlug === 'string' ? body.categorySlug : '')
  if (!(await ensurePendingQuota(payload, user.id))) {
    return Response.json({ error: '你有过多待审核的 Skill，请等审核后再提交' }, { status: 429 })
  }

  const slug = await createUniqueSlug(payload, title)
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
        category: category.id,
        author: user.id,
        clientSubmissionKey: idempotencyKey || undefined,
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
    return Response.json({ ok: true, id: skill.id, slug, status: 'pending' })
  } catch (e) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    const doc = await findIdempotentSkill(payload, user.id, idempotencyKey)
    if (doc) return Response.json({ ok: true, id: doc.id, slug: doc.slug, idempotent: true })
    payload.logger?.error(`发布 Skill 失败: ${(e as Error).message}`)
    return Response.json({ error: '发布失败，请重试' }, { status: 400 })
  }
}
