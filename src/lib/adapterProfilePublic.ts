import { publicSanitize } from './publicSanitize'
import { evidenceVerifyApiUrl, evidenceVerifyPageUrl } from './evidenceLinks'
import { boundedStringParam } from './queryParams'

function isPublicSkillRelation(value: any) {
  if (!value || typeof value !== 'object') return false
  return value.status === 'published' && value.visibility === 'public'
}

export function isPublicAdapterProfile(adapter: any) {
  const reviewStatus = String(adapter?.reviewStatus || 'approved')
  return Boolean(adapter && adapter.status === 'active' && reviewStatus === 'approved' && isPublicSkillRelation(adapter.skill))
}

export function buildAdapterProfileWhere(params: URLSearchParams) {
  const skillId = boundedStringParam(params, 'skillId', 160) || boundedStringParam(params, 'skill', 160)
  const modelName = boundedStringParam(params, 'modelName', 160)
  const modelVersion = boundedStringParam(params, 'modelVersion', 160)
  // Public API only exposes active adapters; review/draft workflows must use admin-only endpoints.
  const status = 'active'
  const failureType = boundedStringParam(params, 'failureType', 80)
  const sourceFailureCase = boundedStringParam(params, 'sourceFailureCase', 160) || boundedStringParam(params, 'failureId', 160)
  const modelProfile = boundedStringParam(params, 'modelProfile', 160)

  const and: any[] = []
  and.push({ status: { equals: status } })
  and.push({ or: [{ reviewStatus: { equals: 'approved' } }, { reviewStatus: { exists: false } }] })
  and.push({ 'skill.status': { equals: 'published' } })
  and.push({ 'skill.visibility': { equals: 'public' } })
  if (skillId) and.push({ skill: { equals: skillId } })
  if (modelName) and.push({ modelName: { equals: modelName } })
  if (modelVersion) {
    and.push({
      or: [
        { modelVersion: { equals: modelVersion } },
        { 'modelProfile.modelVersion': { equals: modelVersion } },
      ],
    })
  }
  if (failureType) and.push({ failureTypes: { contains: failureType } })
  if (sourceFailureCase) and.push({ sourceFailureCase: { equals: sourceFailureCase } })
  if (modelProfile) and.push({ modelProfile: { equals: modelProfile } })
  return and.length ? { and } : undefined
}

function relationSummary(value: any) {
  if (!value) return null
  if (typeof value === 'object')
    return {
      id: String(value.id || ''),
      slug: value.slug || null,
      title: value.title || value.modelName || null,
      modelVersion: value.modelVersion || null,
      provider: value.provider || null,
    }
  return { id: String(value), slug: null, title: null }
}

function adapterPlaybook(adapter: any) {
  const before = adapter?.beforeMetrics && typeof adapter.beforeMetrics === 'object' ? adapter.beforeMetrics : {}
  const after = adapter?.afterMetrics && typeof adapter.afterMetrics === 'object' ? adapter.afterMetrics : {}
  const beforeSamples = Number(before.samples || 0)
  const afterSamples = Number(after.samples || 0)
  const liftScore = Number(adapter?.liftScore || 0)
  const modelParams = adapter?.modelName
    ? new URLSearchParams({
        modelName: String(adapter.modelName),
        ...(adapter?.modelVersion ? { modelVersion: String(adapter.modelVersion) } : {}),
      }).toString()
    : ''
  const ledgerParams = adapter?.modelName
    ? new URLSearchParams({
        model: String(adapter.modelName),
        ...(adapter?.modelVersion ? { modelVersion: String(adapter.modelVersion) } : {}),
        success: 'false',
      }).toString()
    : ''
  const failureType =
    Array.isArray(adapter?.failureTypes) && adapter.failureTypes[0]
      ? String(adapter.failureTypes[0])
      : ''
  const decision =
    liftScore > 0 && afterSamples >= 3
      ? 'reuse'
      : liftScore > 0
        ? 'verify'
        : 'observe'
  return {
    customerValue:
      'Adapter 把失败库里的已知问题变成可复用修复证据：看适用模型、失败类型、前后样本和 lift，再决定复用、复验或继续观察。',
    decision,
    reuseChecklist: [
      '确认 Skill、modelName/modelVersion 与你的运行环境一致',
      '确认 reviewStatus=approved；未批准草稿不能作为公开修复依据',
      '确认失败类型和输入档与来源 FailureCase 一致',
      'after 样本不足 3 时先用私人台账复验，不直接大规模启用',
      '只信公开效果摘要和 evidenceHash，补丁正文仍需作者/审核员权限复核',
    ],
    nextActions: [
      {
        label: '确认适用范围',
        description: `仅用于 ${adapter?.modelName || '指定模型'}${adapter?.modelVersion ? ` · ${adapter.modelVersion}` : ''} 的 ${Array.isArray(adapter?.failureTypes) && adapter.failureTypes.length ? adapter.failureTypes.join(' / ') : '已知失败类型'}。`,
      },
      {
        label: '看 lift 和样本',
        description: `lift ${Number.isFinite(liftScore) ? liftScore : 0}；前 ${beforeSamples} / 后 ${afterSamples}。样本少时先复验，不要直接大规模启用。`,
      },
      {
        label: '用私人台账复验',
        description: '筛出同模型/版本的失败运行，用相同输入复验 Adapter 是否真的提升成功率和格式率。',
        href: ledgerParams ? `/console/runs?${ledgerParams}` : '/console/runs?success=false',
      },
      {
        label: '验签修复证据',
        description: '公开只展示效果摘要，不暴露 prompt/schema/decoding 补丁正文；可验签 evidenceHash。',
        href: evidenceVerifyPageUrl('adapter_profile', adapter?.id),
      },
      {
        label: '查看模型画像',
        description: '确认该模型版本是否有漂移/回归告警，避免把模型升级问题误当成 Skill 问题。',
        href: modelParams ? `/models?${modelParams}` : null,
      },
      {
        label: '回到失败库',
        description: '查看来源失败画像，确认症状、模型版本和输入档是否与你的任务一致。',
        href: modelParams
          ? `/failures?${new URLSearchParams({
              modelName: String(adapter.modelName),
              ...(adapter?.modelVersion ? { modelVersion: String(adapter.modelVersion) } : {}),
              ...(failureType
                ? { errorType: failureType }
                : {}),
            }).toString()}`
          : null,
      },
    ],
  }
}

export function publicAdapterProfile(adapter: any) {
  const skill = isPublicSkillRelation(adapter?.skill) ? relationSummary(adapter?.skill) : null
  return {
    id: String(adapter?.id || ''),
    title: adapter?.title || null,
    skill,
    skillVersion: relationSummary(adapter?.skillVersion),
    sourceFailureCase: relationSummary(adapter?.sourceFailureCase),
    modelProfile: relationSummary(adapter?.modelProfile),
    modelName: adapter?.modelName || null,
    modelVersion: adapter?.modelVersion || adapter?.modelProfile?.modelVersion || null,
    status: adapter?.status || 'draft',
    reviewStatus: adapter?.reviewStatus || 'pending',
    failureTypes: Array.isArray(adapter?.failureTypes) ? adapter.failureTypes : [],
    liftScore: adapter?.liftScore ?? 0,
    beforeMetrics: publicSanitize(adapter?.beforeMetrics || null),
    afterMetrics: publicSanitize(adapter?.afterMetrics || null),
    playbook: publicSanitize(adapterPlaybook(adapter)),
    evidenceHash: adapter?.evidenceHash || null,
    evidenceVerifyUrl: evidenceVerifyApiUrl('adapter_profile', adapter?.id),
    evidenceVerifyPageUrl: evidenceVerifyPageUrl('adapter_profile', adapter?.id),
    lastVerifiedAt: adapter?.lastVerifiedAt || null,
  }
}
