
import { publicSanitize } from './publicSanitize'
import { evidenceVerifyApiUrl, evidenceVerifyPageUrl } from './evidenceLinks'
import { boundedStringParam } from './queryParams'

export const PUBLIC_FAILURE_STATUSES = ['observed', 'confirmed', 'fixed'] as const
const PUBLIC_FAILURE_STATUS_SET = new Set(PUBLIC_FAILURE_STATUSES)

function isPublicSkillRelation(value: any) {
  if (!value) return true
  if (typeof value !== 'object') return false
  return value.status === 'published' && value.visibility === 'public'
}

export function isPublicFailureCase(row: any) {
  return Boolean(
    row &&
    PUBLIC_FAILURE_STATUS_SET.has(String(row.status || 'observed') as any) &&
    isPublicSkillRelation(row.skill),
  )
}

export function buildFailureCaseWhere(params: URLSearchParams) {
  const errorType = boundedStringParam(params, 'errorType', 80)
  const modelName = boundedStringParam(params, 'modelName', 160)
  const modelVersion = boundedStringParam(params, 'modelVersion', 160)
  const status = params.get('status')?.trim()
  const skillId = boundedStringParam(params, 'skillId', 160) || boundedStringParam(params, 'skill', 160)
  const profileKey = boundedStringParam(params, 'profileKey', 200)
  const inputBucket = boundedStringParam(params, 'inputBucket', 32)
  const source = boundedStringParam(params, 'source', 40).replace(/[^\w.-]/g, '')

  const and: any[] = []
  and.push(
    PUBLIC_FAILURE_STATUSES.includes(status as any)
      ? { status: { equals: status } }
      : { status: { in: [...PUBLIC_FAILURE_STATUSES] } },
  )
  and.push({
    or: [
      { skill: { exists: false } },
      {
        and: [
          { 'skill.status': { equals: 'published' } },
          { 'skill.visibility': { equals: 'public' } },
        ],
      },
    ],
  })
  if (errorType) and.push({ errorType: { equals: errorType } })
  if (modelName) and.push({ modelName: { equals: modelName } })
  if (modelVersion) and.push({ modelVersions: { contains: modelVersion } })
  if (skillId) and.push({ skill: { equals: skillId } })
  if (profileKey) and.push({ profileKey: { equals: profileKey } })
  if (inputBucket) and.push({ inputBuckets: { contains: inputBucket } })
  if (source) and.push({ [`sourceBreakdown.${source}`]: { greater_than: 0 } })
  return and.length ? { and } : undefined
}

function relationSummary(value: any) {
  if (!value) return null
  if (typeof value === 'object') {
    return {
      id: String(value.id || ''),
      slug: value.slug || null,
      title: value.title || value.name || null,
    }
  }
  return { id: String(value), slug: null, title: null }
}

function modelProfileUrl(modelName: unknown, modelVersion?: unknown) {
  if (!modelName) return null
  const params = new URLSearchParams({ modelName: String(modelName) })
  if (modelVersion) params.set('modelVersion', String(modelVersion))
  return `/models?${params.toString()}`
}

function adaptersUrl(row: any) {
  if (!row?.modelName || !row?.id) return null
  const params = new URLSearchParams({
    modelName: String(row.modelName),
    failureId: String(row.id),
  })
  if (row.primaryModelVersion) params.set('modelVersion', String(row.primaryModelVersion))
  return `/v1/adapters?${params.toString()}`
}

function publicFailurePlaybook(row: any) {
  const profileKey =
    row?.profileKey ||
    [row?.errorType, row?.modelName].filter(Boolean).join('|') ||
    null
  return {
    customerValue:
      '把一次失败沉淀成可复用排障线索：先判断是否命中已知失败模式，再看模型画像，最后由作者生成 Adapter 草稿并复验效果。',
    profileKey,
    safeForPublic: true,
    nextActions: [
      {
        label: '确认是否同类失败',
        description: '对照错误类型、输入档、模型版本、症状和可能原因，不需要暴露原始输入输出。',
      },
      {
        label: '查看模型画像',
        description: '判断失败是否集中在某个模型或版本，决定换模型、锁版本还是等待适配。',
        href: modelProfileUrl(row?.modelName, row?.primaryModelVersion),
      },
      {
        label: '生成或复用 Adapter',
        description: '作者/审核员可从失败案例生成补丁草稿；公开用户只能看是否已有验证过的 Adapter 效果。',
        href: adaptersUrl(row),
      },
      {
        label: '验签证据',
        description: '复核这条失败画像是否来自公开可验证的证据快照。',
        href: evidenceVerifyPageUrl('failure_case', row?.id),
      },
    ],
  }
}

function objectOrEmpty(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function publicFailureCase(row: any) {
  const skill = isPublicSkillRelation(row?.skill) ? relationSummary(row?.skill) : null
  return {
    id: String(row?.id || ''),
    title: row?.title || null,
    profileKey: row?.profileKey || null,
    errorType: row?.errorType || null,
    modelName: row?.modelName || null,
    primaryModelVersion: row?.primaryModelVersion || null,
    modelProfileUrl: modelProfileUrl(row?.modelName, row?.primaryModelVersion),
    adaptersUrl: adaptersUrl(row),
    playbook: publicFailurePlaybook(row),
    skill,
    symptom: row?.symptom || null,
    likelyCause: row?.likelyCause || null,
    hasRepairTemplate: Boolean(row?.repairTemplate),
    hasVerifyTemplate: Boolean(row?.verifyTemplate),
    primaryInputBucket: row?.primaryInputBucket || null,
    inputBuckets: Array.isArray(row?.inputBuckets) ? row.inputBuckets : [],
    outputBuckets: Array.isArray(row?.outputBuckets) ? row.outputBuckets : [],
    modelBreakdown: publicSanitize(objectOrEmpty(row?.modelBreakdown)),
    modelVersions: Array.isArray(row?.modelVersions) ? row.modelVersions : [],
    modelVersionBreakdown: publicSanitize(objectOrEmpty(row?.modelVersionBreakdown)),
    sourceBreakdown: publicSanitize(objectOrEmpty(row?.sourceBreakdown)),
    evidenceHash: row?.evidenceHash || null,
    evidenceVerifyUrl: evidenceVerifyApiUrl('failure_case', row?.id),
    evidenceVerifyPageUrl: evidenceVerifyPageUrl('failure_case', row?.id),
    occurrenceCount: row?.occurrenceCount || 0,
    affectedSkillCount: row?.affectedSkillCount || 0,
    status: row?.status || 'observed',
    lastObservedAt: row?.lastObservedAt || null,
  }
}
