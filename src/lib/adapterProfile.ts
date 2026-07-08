import type { Payload } from 'payload'
import { evidenceHash } from './evidenceHash'

export interface AppliedAdapter {
  adapterId?: string
  systemPromptAppend?: string
  userPromptAppend?: string
  outputSchema?: any
  temperature?: number
  maxTokens?: number
}

function mergeSchema(base: any, patch: any) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  if (!base || typeof base !== 'object' || Array.isArray(base)) return patch
  return { ...base, ...patch }
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, value))
}

function refId(value: any): string | undefined {
  if (!value) return undefined
  return typeof value === 'object' ? String(value.id || '') || undefined : String(value)
}

export function buildAdapterEvidenceHash(adapter: any): string {
  return evidenceHash({
    skill: refId(adapter?.skill),
    skillVersion: refId(adapter?.skillVersion),
    sourceFailureCase: refId(adapter?.sourceFailureCase),
    modelProfile: refId(adapter?.modelProfile),
    modelName: adapter?.modelName || null,
    modelVersion: adapter?.modelVersion || adapter?.modelProfile?.modelVersion || null,
    status: adapter?.status || 'draft',
    reviewStatus: adapter?.reviewStatus || 'pending',
    systemPromptAppend: adapter?.systemPromptAppend || null,
    userPromptAppend: adapter?.userPromptAppend || null,
    outputSchemaPatch: adapter?.outputSchemaPatch || null,
    decodingPatch: adapter?.decodingPatch || null,
    retryPolicy: adapter?.retryPolicy || null,
    failureTypes: adapter?.failureTypes || null,
    liftScore: adapter?.liftScore ?? 0,
    beforeMetrics: adapter?.beforeMetrics || null,
    afterMetrics: adapter?.afterMetrics || null,
  })
}

export function applyAdapterToVersion(version: any, adapter?: any): { version: any; applied: AppliedAdapter | null } {
  if (!adapter) return { version, applied: null }
  const decoding = adapter.decodingPatch && typeof adapter.decodingPatch === 'object' ? adapter.decodingPatch : {}
  const systemAppend = typeof adapter.systemPromptAppend === 'string' ? adapter.systemPromptAppend.trim() : ''
  const userAppend = typeof adapter.userPromptAppend === 'string' ? adapter.userPromptAppend.trim() : ''
  const outputSchema = mergeSchema(version?.outputSchema, adapter.outputSchemaPatch)
  const adapted = {
    ...version,
    systemPrompt: [version?.systemPrompt || '', systemAppend].filter(Boolean).join('\n\n'),
    promptTemplate: [version?.promptTemplate || '', userAppend].filter(Boolean).join('\n\n'),
    outputSchema,
    adapterRuntime: {
      adapterId: adapter.id,
      temperature: boundedNumber(decoding.temperature, 0, 2),
      maxTokens: boundedNumber(decoding.maxTokens ?? decoding.max_tokens, 1, 32_000),
    },
  }
  return {
    version: adapted,
    applied: {
      adapterId: adapter.id,
      systemPromptAppend: systemAppend || undefined,
      userPromptAppend: userAppend || undefined,
      outputSchema,
      temperature: adapted.adapterRuntime.temperature,
      maxTokens: adapted.adapterRuntime.maxTokens,
    },
  }
}

export async function findActiveAdapter(payload: Payload, args: {
  skillId?: string
  versionId?: string
  modelName?: string
  modelVersion?: string
  modelProfile?: string
}) {
  if (!args.skillId || (!args.modelName && !args.modelProfile)) return null
  const modelWhere: any[] = []
  if (args.modelProfile) modelWhere.push({ modelProfile: { equals: args.modelProfile } })
  if (args.modelName) modelWhere.push({ modelName: { equals: args.modelName } })
  const versionWhere = args.modelVersion
    ? {
        or: [
          { modelVersion: { equals: args.modelVersion } },
          { modelVersion: { exists: false } },
        ],
      }
    : undefined
  const res = await payload.find({
    collection: 'adapter-profiles' as any,
    where: {
      and: [
        { skill: { equals: args.skillId } },
        modelWhere.length === 1 ? modelWhere[0] : { or: modelWhere },
        ...(versionWhere ? [versionWhere] : []),
        { status: { equals: 'active' } },
        { or: [{ reviewStatus: { equals: 'approved' } }, { reviewStatus: { exists: false } }] },
        {
          or: [
            { skillVersion: { equals: args.versionId } },
            { skillVersion: { exists: false } },
          ],
        },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    sort: '-liftScore',
  }).catch(() => ({ docs: [] as any[] }))
  return (res.docs as any[])[0] || null
}

function relationId(value: any): string | undefined {
  if (!value) return undefined
  return typeof value === 'object' ? String(value.id || '') || undefined : String(value)
}

function metricsFromReports(reports: any[]) {
  const n = reports.length
  const success = reports.filter((r) => r.success).length
  const format = reports.filter((r) => r.formatValid).length
  const latencies = reports.map((r) => Number(r.latencyMs)).filter((n) => Number.isFinite(n) && n > 0)
  return {
    samples: n,
    successRate: n ? success / n : null,
    formatRate: n ? format / n : null,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
  }
}

export function computeAdapterLift(beforeReports: any[], afterReports: any[]) {
  const before = metricsFromReports(beforeReports)
  const after = metricsFromReports(afterReports)
  const beforeSuccess = before.successRate ?? 0
  const afterSuccess = after.successRate ?? 0
  const beforeFormat = before.formatRate ?? 0
  const afterFormat = after.formatRate ?? 0
  const liftScore = Math.round(((afterSuccess - beforeSuccess) * 70 + (afterFormat - beforeFormat) * 30) * 100) / 100
  return { before, after, liftScore }
}

export async function refreshAdapterLift(payload: Payload, adapter: any) {
  const adapterId = relationId(adapter?.id)
  const skillId = relationId(adapter?.skill)
  const modelName = adapter?.modelName ? String(adapter.modelName) : ''
  const modelVersion = adapter?.modelVersion ? String(adapter.modelVersion) : ''
  if (!adapterId || !skillId || !modelName) return null

  const baseWhere: any[] = [
    { skill: { equals: skillId } },
    { modelName: { equals: modelName } },
  ]
  if (modelVersion) baseWhere.push({ modelVersion: { equals: modelVersion } })
  const [beforeRes, afterRes] = await Promise.all([
    payload.find({
      collection: 'compat-reports' as any,
      where: { and: [...baseWhere, { adapterProfile: { exists: false } }] },
      limit: 500,
      depth: 0,
      overrideAccess: true,
      sort: '-createdAt',
    }).catch(() => ({ docs: [] as any[] })),
    payload.find({
      collection: 'compat-reports' as any,
      where: { and: [...baseWhere, { adapterProfile: { equals: adapterId } }] },
      limit: 500,
      depth: 0,
      overrideAccess: true,
      sort: '-createdAt',
    }).catch(() => ({ docs: [] as any[] })),
  ])

  const lift = computeAdapterLift(beforeRes.docs as any[], afterRes.docs as any[])
  const data = {
    beforeMetrics: lift.before,
    afterMetrics: lift.after,
    liftScore: lift.liftScore,
    lastVerifiedAt: new Date().toISOString(),
  }
  return payload.update({
    collection: 'adapter-profiles' as any,
    id: adapterId,
    data,
    overrideAccess: true,
  })
}


export function buildAdapterDraftFromFailureCase(failureCase: any, overrides: Record<string, unknown> = {}) {
  const skillId = relationId(failureCase?.skill)
  const skillVersionId = relationId(failureCase?.skillVersion)
  const modelName = failureCase?.modelName ? String(failureCase.modelName) : ''
  const modelVersion = failureCase?.primaryModelVersion ? String(failureCase.primaryModelVersion) : undefined
  const errorType = failureCase?.errorType ? String(failureCase.errorType) : 'unknown_error'
  const title = `${failureCase?.title || '失败修复'} Adapter 草稿`
  return {
    title,
    skill: skillId,
    skillVersion: skillVersionId,
    sourceFailureCase: relationId(failureCase?.id),
    modelName,
    modelVersion,
    status: 'draft',
    reviewStatus: 'pending',
    systemPromptAppend: failureCase?.repairTemplate
      ? `针对历史失败「${errorType}」的修复约束：\n${String(failureCase.repairTemplate)}`
      : undefined,
    userPromptAppend: failureCase?.verifyTemplate
      ? `请在生成后自检：${String(failureCase.verifyTemplate)}`
      : undefined,
    retryPolicy: {
      source: 'failure_case',
      profileKey: failureCase?.profileKey || null,
      primaryInputBucket: failureCase?.primaryInputBucket || null,
      verifyTemplate: failureCase?.verifyTemplate || null,
    },
    failureTypes: [errorType],
    ...overrides,
  }
}

export function adapterDraftSummary(adapter: any) {
  if (!adapter) return null
  return {
    id: String(adapter.id || ''),
    title: adapter.title || null,
    skill: relationId(adapter.skill) || null,
    skillVersion: relationId(adapter.skillVersion) || null,
    sourceFailureCase: relationId(adapter.sourceFailureCase) || null,
    modelName: adapter.modelName || null,
    modelVersion: adapter.modelVersion || adapter.modelProfile?.modelVersion || null,
    status: adapter.status || 'draft',
    reviewStatus: adapter.reviewStatus || 'pending',
    review: adapterReviewPlaybook(adapter),
    failureTypes: Array.isArray(adapter.failureTypes) ? adapter.failureTypes : [],
    adminUrl: adapter.id ? `/admin/collections/adapter-profiles/${encodeURIComponent(String(adapter.id))}` : null,
    createdAt: adapter.createdAt || undefined,
    updatedAt: adapter.updatedAt || undefined,
  }
}

export function adapterReviewPlaybook(adapter: any) {
  const status = String(adapter?.reviewStatus || 'pending')
  const decision =
    status === 'approved'
      ? 'ready_to_verify'
      : status === 'needs_changes'
        ? 'revise'
        : status === 'rejected'
          ? 'stop'
          : 'review'
  return {
    decision,
    reviewStatus: status,
    customerValue: '把 Adapter 从“作者自己说能修”变成经人工复核、再用私人台账复验的修复资产。',
    reviewChecklist: [
      '确认来源 FailureCase、SkillVersion、modelName/modelVersion 属于同一问题链路',
      '检查 prompt/schema/decoding/retry 补丁是否只修目标失败类型',
      '用至少一条私人台账失败输入复验 before/after，避免只看草稿描述',
      '批准后再启用 active；未批准草稿不得进入公开 Adapter 复用链路',
    ],
    nextActions: [
      {
        label: status === 'approved' ? '复验 lift' : '提交人工评审',
        description: status === 'approved'
          ? '已通过人工评审，下一步用真实失败输入复验 lift 和格式率。'
          : '先由作者/审核员在后台核对补丁边界、来源失败和版本适用范围。',
        href: adapter?.id ? `/admin/collections/adapter-profiles/${encodeURIComponent(String(adapter.id))}` : null,
      },
      {
        label: '回到来源失败',
        description: '对照失败画像确认症状、输入档和模型版本，避免把不相干问题合并到同一个 Adapter。',
        href: adapter?.sourceFailureCase ? `/failures?failureId=${encodeURIComponent(String(relationId(adapter.sourceFailureCase) || adapter.sourceFailureCase))}` : null,
      },
      {
        label: '用私人台账复验',
        description: '筛出同模型失败运行，用原输入重跑，确认 Adapter 真的提升成功率和格式率。',
        href: adapter?.modelName ? `/console/runs?model=${encodeURIComponent(String(adapter.modelName))}&success=false` : '/console/runs?success=false',
      },
    ],
  }
}

export async function canCreateAdapterFromFailureCase(
  payload: Payload,
  args: { userId: string; userRole?: string; failureCase: any },
): Promise<{ ok: true; skill: any } | { ok: false; reason: string }> {
  const skillId = relationId(args.failureCase?.skill)
  if (!skillId) return { ok: false, reason: '该失败案例没有代表 Skill，暂不能生成 Adapter' }
  const skill = await payload
    .findByID({ collection: 'skills' as any, id: skillId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!skill) return { ok: false, reason: '代表 Skill 不存在' }
  if (['admin', 'reviewer'].includes(String(args.userRole || ''))) return { ok: true, skill }
  const authorId = relationId(skill.author)
  if (authorId && String(authorId) === String(args.userId)) return { ok: true, skill }
  return { ok: false, reason: '只有 Skill 作者或审核人员可以从该失败案例生成 Adapter' }
}

export async function createAdapterDraftFromFailureCase(
  payload: Payload,
  args: { userId: string; userRole?: string; failureCaseId: string; overrides?: Record<string, unknown> },
): Promise<{ ok: true; adapter: any } | { ok: false; reason: string }> {
  const failureCase = await payload
    .findByID({ collection: 'failure-cases' as any, id: args.failureCaseId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!failureCase) return { ok: false, reason: '失败案例不存在' }
  const access = await canCreateAdapterFromFailureCase(payload, { userId: args.userId, userRole: args.userRole, failureCase })
  if (!access.ok) return access
  const draft = buildAdapterDraftFromFailureCase(failureCase, args.overrides)
  if (!draft.skill || !draft.modelName) return { ok: false, reason: '失败案例缺少 Skill 或模型信息' }

  const existing = await payload.find({
    collection: 'adapter-profiles' as any,
    where: {
      and: [
        { sourceFailureCase: { equals: args.failureCaseId } },
        { skill: { equals: draft.skill } },
        { modelName: { equals: draft.modelName } },
        { status: { equals: 'draft' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  }).catch(() => ({ docs: [] as any[] }))
  if ((existing.docs as any[])[0]) return { ok: true, adapter: (existing.docs as any[])[0] }

  const adapter = await payload.create({
    collection: 'adapter-profiles' as any,
    data: draft,
    depth: 0,
    overrideAccess: true,
  })
  return { ok: true, adapter }
}
