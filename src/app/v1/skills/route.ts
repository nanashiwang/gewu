import { getPayload } from 'payload'
import type { Payload, PayloadRequest } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { slugify } from '@/lib/slug'
import { normalizeSkillSubmissionKey } from '@/lib/skillSubmission'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'
import { notify } from '@/lib/notify'
import { publicSkillSummary } from '@/lib/skillPublic'
import { refreshSkillPassport } from '@/lib/passportRefresh'
import { normalizeSkillSubmissionVisibility } from '@/lib/skillVisibility'
import { readJsonBodyWithLimit } from '@/lib/requestBody'
import { boundedIntParam, boundedStringParam } from '@/lib/queryParams'
import { MAX_SKILL_PROMPT_SUBMISSION_BYTES, normalizeSkillPromptSubmission } from '@/lib/skillPromptSubmissionRequest'
import {
  MAX_SKILL_PACKAGE_CATEGORY_LENGTH,
  MAX_SKILL_PACKAGE_DESCRIPTION_LENGTH,
  MAX_SKILL_PACKAGE_TITLE_LENGTH,
  preflightSkillPackageFormRequest,
  readSkillPackageText,
} from '@/lib/skillPackageSubmissionRequest'
import {
  analyzeSkillPackage,
  packageStatusForReview,
  reviewSkillPackage,
  reviewToChangelog,
  storeSkillPackage,
} from '@/lib/skillPackage'
import { certificateVerifyPageUrl } from '@/lib/evidenceLinks'
import { skillPublishPlaybook } from '@/lib/skillPublishPlaybook'

// GET /v1/skills —— 公开读取 Skill 列表；可用于必备 Skill onboarding 和外部目录集成。
export async function GET(request: Request) {
  const payload = await getPayload({ config })
  const url = new URL(request.url)
  const q = boundedStringParam(url.searchParams, 'q', 120)
  const category = boundedStringParam(url.searchParams, 'category', 80)
  const essential = url.searchParams.get('essential') === '1'
  const featured = url.searchParams.get('featured') === '1'
  const limit = boundedIntParam(url.searchParams, 'limit', 50, 1, 200)
  const page = boundedIntParam(url.searchParams, 'page', 1, 1, 10_000)
  const sort =
    url.searchParams.get('sort') === 'new' ? '-createdAt' : '-skillRank'

  const and: any[] = [
    { status: { equals: 'published' } },
    { visibility: { equals: 'public' } },
  ]
  if (q) and.push({ title: { like: q } })
  if (essential) and.push({ isEssential: { equals: true } })
  if (featured) and.push({ isFeatured: { equals: true } })
  if (category) {
    const cats = await payload.find({
      collection: 'categories',
      where: { slug: { equals: category } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const cat = cats.docs[0] as any
    if (!cat)
      return Response.json({
        totalDocs: 0,
        page,
        totalPages: 0,
        limit,
        docs: [],
      })
    and.push({ category: { equals: cat.id } })
  }

  const res = await payload.find({
    collection: 'skills',
    where: { and },
    depth: 1,
    limit,
    page,
    sort,
    overrideAccess: true,
  })
  const passportEntries = await Promise.all(
    (res.docs as any[]).map(async (skill) => {
      const passports = await payload.find({
        collection: 'skill-passports' as any,
        where: {
          and: [
            { skill: { equals: skill.id } },
            { status: { equals: 'current' } },
          ],
        },
        sort: '-lastVerifiedAt',
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      return [skill.id, passports.docs[0] || null] as const
    }),
  )
  const passportBySkillId = new Map(passportEntries)
  return Response.json({
    totalDocs: res.totalDocs,
    page: res.page,
    totalPages: res.totalPages,
    limit,
    docs: (res.docs as any[]).map((skill) =>
      publicSkillSummary(skill, passportBySkillId.get(skill.id)),
    ),
  })
}

// POST /v1/skills —— 创作者发布 Skill。
// JSON：兼容旧的 Prompt 表单；multipart/form-data：新 Skill 包上传 + 规则/AI 自动审核。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned')
    return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    return handlePackageSubmission(payload, request, user as any)
  }
  return handlePromptSubmission(payload, request, user as any)
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
  return {
    id: cat?.id as string | undefined,
    name: cat?.name ? String(cat.name) : categorySlug,
  }
}

async function ensurePendingQuota(payload: Payload, userId: string) {
  const pending = await payload.count({
    collection: 'skills',
    where: {
      and: [{ author: { equals: userId } }, { status: { equals: 'pending' } }],
    },
    overrideAccess: true,
  })
  return pending.totalDocs < 20
}

async function findIdempotentSkill(
  payload: Payload,
  userId: string,
  idempotencyKey: string | undefined,
) {
  if (!idempotencyKey) return null
  const existing = await payload.find({
    collection: 'skills',
    where: {
      and: [
        { author: { equals: userId } },
        { clientSubmissionKey: { equals: idempotencyKey } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return existing.docs[0] as any
}

async function notifySkillReviewers(
  payload: Payload,
  skill: any,
  review: any,
  actorId: string,
) {
  const staff = await payload.find({
    collection: 'users',
    where: {
      and: [
        { accountStatus: { equals: 'active' } },
        {
          or: [{ role: { equals: 'admin' } }, { role: { equals: 'reviewer' } }],
        },
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
  if (!models || typeof models !== 'object' || Array.isArray(models))
    return models
  if (models.cloud || models.local) return models
  const out: Record<string, unknown> = { ...models }
  if (Array.isArray(models.cloud_recommended))
    out.cloud = models.cloud_recommended
  if (Array.isArray(models.local_recommended))
    out.local = models.local_recommended
  return out
}

function fallbackPromptTemplate(
  title: string,
  description: string,
  analysis: ReturnType<typeof analyzeSkillPackage>,
) {
  const readme = (analysis.readmeText || '').slice(0, 3000)
  const fileList = analysis.entries
    .slice(0, 80)
    .map((e) => `- ${e.name}`)
    .join('\n')
  return [
    `你正在运行用户上传的 Skill「${title}」。`,
    description ? `简介：${description}` : '',
    readme ? `README：\n${readme}` : '',
    fileList ? `包内文件：\n${fileList}` : '',
    '',
    '用户本次补充要求：',
    '{{request}}',
    '',
    '请严格根据上述 Skill 说明和用户补充要求完成任务；如果说明不足，请先说明缺少什么信息，不要编造不存在的能力。',
  ]
    .filter(Boolean)
    .join('\n')
}

function fallbackInputSchema(analysis: ReturnType<typeof analyzeSkillPackage>) {
  return (
    analysis.inputSchema || {
      request: {
        type: 'text',
        label: '本次使用要求',
        required: false,
        placeholder:
          '可补充你希望这个 Skill 如何处理本次任务；若不填，将仅按包内 README/简介执行。',
      },
    }
  )
}

async function handlePackageSubmission(
  payload: Payload,
  request: Request,
  user: any,
) {
  const preflight = preflightSkillPackageFormRequest(request)
  if (!preflight.ok) return Response.json({ error: preflight.error }, { status: preflight.status })
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return Response.json({ error: '表单数据无效' }, { status: 400 })
  }

  const titleValue = readSkillPackageText(form.get('title'), MAX_SKILL_PACKAGE_TITLE_LENGTH, 'title', true)
  if (!titleValue.ok) return Response.json({ error: titleValue.error }, { status: titleValue.status })
  const descriptionValue = readSkillPackageText(form.get('description'), MAX_SKILL_PACKAGE_DESCRIPTION_LENGTH, 'description')
  if (!descriptionValue.ok) return Response.json({ error: descriptionValue.error }, { status: descriptionValue.status })
  const categoryValue = readSkillPackageText(form.get('categorySlug'), MAX_SKILL_PACKAGE_CATEGORY_LENGTH, 'categorySlug')
  if (!categoryValue.ok) return Response.json({ error: categoryValue.error }, { status: categoryValue.status })
  const title = titleValue.value
  const description = descriptionValue.value
  const categorySlug = categoryValue.value
  const visibility = normalizeSkillSubmissionVisibility(form.get('visibility'), user)
  const idempotencyKey = normalizeSkillSubmissionKey(
    form.get('idempotencyKey') || request.headers.get('Idempotency-Key'),
  )
  const existing = await findIdempotentSkill(payload, user.id, idempotencyKey)
  if (existing)
    return Response.json({
      ok: true,
      id: existing.id,
      slug: existing.slug,
      status: existing.status,
      idempotent: true,
    })

  if (!(await ensurePendingQuota(payload, user.id))) {
    return Response.json(
      { error: '你有过多待审核的 Skill，请等审核后再提交' },
      { status: 429 },
    )
  }

  const upload = form.get('skillPackage') as any
  if (!upload || typeof upload.arrayBuffer !== 'function') {
    return Response.json({ error: '请上传 Skill 压缩包' }, { status: 400 })
  }
  const fileName =
    typeof upload.name === 'string' ? upload.name : 'skill-package.zip'
  const buffer = Buffer.from(await upload.arrayBuffer())

  let analysis: ReturnType<typeof analyzeSkillPackage>
  try {
    analysis = analyzeSkillPackage(fileName, buffer)
  } catch (e) {
    return Response.json(
      { error: 'Skill 包解析失败，请检查压缩包格式和文件大小' },
      { status: 400 },
    )
  }
  const blocker = analysis.issues.find((i) => i.level === 'blocker')
  if (blocker) {
    return Response.json(
      { error: blocker.message, code: blocker.code, issues: analysis.issues },
      { status: 400 },
    )
  }

  const category = await resolveCategory(payload, categorySlug)
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const review = await reviewSkillPackage({
    title,
    category: category.name,
    description,
    analysis,
    env: runtimeEnv,
  })
  const status = packageStatusForReview(review, analysis)
  const slug = await createUniqueSlug(payload, title)
  const promptTemplate =
    analysis.promptTemplate ||
    fallbackPromptTemplate(title, description, analysis)

  const transactionID = await payload.db.beginTransaction()
  const txReq: Partial<PayloadRequest> | undefined = transactionID
    ? { transactionID }
    : undefined
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
        description:
          description ||
          analysis.manifest?.description ||
          analysis.readmeText?.slice(0, 220) ||
          undefined,
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
        inputSchema: fallbackInputSchema(analysis),
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
    if (doc)
      return Response.json({
        ok: true,
        id: doc.id,
        slug: doc.slug,
        status: doc.status,
        idempotent: true,
      })
    payload.logger?.error(`发布 Skill 包失败: ${(e as Error).message}`)
    return Response.json({ error: '发布失败，请重试' }, { status: 400 })
  }

  try {
    await storeSkillPackage({
      skillId: skill.id,
      versionId: version.id,
      analysis,
      buffer,
    })
  } catch (e) {
    await payload
      .update({
        collection: 'skills',
        id: skill.id,
        data: { status: 'pending' },
        overrideAccess: true,
      })
      .catch(() => null)
    payload.logger?.error(`保存 Skill 包失败: ${(e as Error).message}`)
    return Response.json(
      { error: 'Skill 已保存但包文件落盘失败，请联系管理员处理' },
      { status: 500 },
    )
  }
  await payload.update({
    collection: 'skills',
    id: skill.id,
    data: { currentVersion: version.id },
    overrideAccess: true,
  })
  await refreshSkillPassport(payload, String(skill.id)).catch((e) =>
    payload.logger?.error(`刷新 Skill Passport 初稿失败: ${(e as Error).message}`),
  )

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
    contractUrl: `/v1/skills/${encodeURIComponent(slug)}/contract`,
    passportUrl: `/v1/skills/${encodeURIComponent(slug)}/passport`,
    certificateUrl: `/v1/skills/${encodeURIComponent(slug)}/certificate`,
    certificateVerifyPageUrl: certificateVerifyPageUrl(`/v1/skills/${encodeURIComponent(slug)}/certificate`),
    playbook: skillPublishPlaybook({ slug, status, reviewDecision: review.decision, autoPublished: status === 'published' }),
    review: {
      decision: review.decision,
      riskLevel: review.riskLevel,
      summary: review.summary,
      findings: review.findings,
      reviewedBy: review.reviewedBy,
    },
  })
}

async function handlePromptSubmission(
  payload: Payload,
  request: Request,
  user: any,
) {
  const parsed = await readJsonBodyWithLimit(request, MAX_SKILL_PROMPT_SUBMISSION_BYTES, 'Prompt Skill 发布请求体过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const normalized = normalizeSkillPromptSubmission(parsed.value)
  if (!normalized.ok) return Response.json({ error: normalized.error }, { status: normalized.status })
  const body = normalized.value
  const title = body.title
  const promptTemplate = body.promptTemplate
  const idempotencyKey = normalizeSkillSubmissionKey(
    body.idempotencyKey || request.headers.get('Idempotency-Key'),
  )

  const existing = await findIdempotentSkill(payload, user.id, idempotencyKey)
  if (existing)
    return Response.json({
      ok: true,
      id: existing.id,
      slug: existing.slug,
      idempotent: true,
    })

  const category = await resolveCategory(payload, body.categorySlug)
  if (!(await ensurePendingQuota(payload, user.id))) {
    return Response.json(
      { error: '你有过多待审核的 Skill，请等审核后再提交' },
      { status: 429 },
    )
  }

  const slug = await createUniqueSlug(payload, title)
  const transactionID = await payload.db.beginTransaction()
  const txReq: Partial<PayloadRequest> | undefined = transactionID
    ? { transactionID }
    : undefined
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
        description: body.description,
        category: category.id,
        author: user.id,
        clientSubmissionKey: idempotencyKey || undefined,
        status: 'pending',
        visibility: 'public',
      },
    })
    version = await payload.create({
      collection: 'skill-versions',
      overrideAccess: true,
      req: txReq,
      data: {
        skill: skill.id,
        version: '1.0.0',
        systemPrompt: body.systemPrompt,
        promptTemplate,
        inputSchema: body.inputSchema as any,
        recommendedModels: body.recommendedModels as any,
        status: 'active',
        createdBy: user.id,
      },
    })
    if (transactionID) await payload.db.commitTransaction(transactionID)
  } catch (e) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    const doc = await findIdempotentSkill(payload, user.id, idempotencyKey)
    if (doc)
      return Response.json({
        ok: true,
        id: doc.id,
        slug: doc.slug,
        idempotent: true,
      })
    payload.logger?.error(`发布 Skill 失败: ${(e as Error).message}`)
    return Response.json({ error: '发布失败，请重试' }, { status: 400 })
  }
  await payload
    .update({
      collection: 'skills',
      id: skill.id,
      data: { currentVersion: version.id },
      overrideAccess: true,
    })
    .catch((e) =>
      payload.logger?.error(`写入 Skill 当前版本失败: ${(e as Error).message}`),
    )
  await refreshSkillPassport(payload, String(skill.id)).catch((e) =>
    payload.logger?.error(`刷新 Prompt Skill Passport 初稿失败: ${(e as Error).message}`),
  )
  return Response.json({
    ok: true,
    id: skill.id,
    slug,
    status: 'pending',
    contractUrl: `/v1/skills/${encodeURIComponent(slug)}/contract`,
    passportUrl: `/v1/skills/${encodeURIComponent(slug)}/passport`,
    certificateUrl: `/v1/skills/${encodeURIComponent(slug)}/certificate`,
    certificateVerifyPageUrl: certificateVerifyPageUrl(`/v1/skills/${encodeURIComponent(slug)}/certificate`),
    playbook: skillPublishPlaybook({ slug, status: 'pending' }),
  })
}
