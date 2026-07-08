import { evidenceHash } from './evidenceHash'
import { publicSanitize } from './publicSanitize'
import { skillContractHash } from './skillContract'

function relationId(value: any): string | null {
  if (!value) return null
  return typeof value === 'object' ? String(value.id || '') || null : String(value)
}

export function publicRoutePolicy(routePolicy: any) {
  if (!routePolicy || typeof routePolicy !== 'object' || Array.isArray(routePolicy)) return null
  const { dataDriven: _dataDriven, ...rest } = routePolicy
  return publicSanitize(rest)
}

export type PublicSkillContractOptions = {
  slug?: string | null
  previousVersion?: any
  baselineSource?: 'auto_previous' | 'requested_version' | 'requested_id' | 'none'
}

const CONTRACT_DIFF_FIELDS = [
  'systemPrompt',
  'promptTemplate',
  'inputSchema',
  'outputSchema',
  'recommendedModels',
  'routePolicy',
  'permissions',
  'minRunnerVersion',
] as const

const BREAKING_DIFF_FIELDS = new Set(['inputSchema', 'outputSchema', 'permissions', 'minRunnerVersion'])
const HASH_ONLY_DIFF_FIELDS = new Set(['systemPrompt', 'promptTemplate'])

export function publicContractBaselineList(versions: any[], currentId?: string) {
  return versions
    .filter((version) => String(version?.id || '') !== String(currentId || '') && version?.status !== 'deprecated')
    .map((version) => ({
      id: String(version?.id || ''),
      version: version?.version || null,
      status: version?.status || null,
      contractStatus: version?.contractStatus || 'initial',
      contractHash: version?.contractHash || skillContractHash(version),
      updatedAt: version?.updatedAt || null,
    }))
}

export function selectContractBaseline(versions: any[], current: any, params: URLSearchParams = new URLSearchParams()) {
  const currentId = String(current?.id || '')
  const candidates = versions.filter((version) => String(version?.id || '') !== currentId && version?.status !== 'deprecated')
  const requestedId = params.get('compareVersionId')?.trim()
  const requestedVersion = params.get('compareVersion')?.trim()
  if (requestedVersion === 'none') return { previousVersion: undefined, baselineSource: 'none' as const, availableBaselines: publicContractBaselineList(versions, currentId) }
  if (requestedId) {
    const found = candidates.find((version) => String(version?.id || '') === requestedId)
    return { previousVersion: found, baselineSource: 'requested_id' as const, availableBaselines: publicContractBaselineList(versions, currentId), missing: !found }
  }
  if (requestedVersion) {
    const found = candidates.find((version) => String(version?.version || '') === requestedVersion)
    return { previousVersion: found, baselineSource: 'requested_version' as const, availableBaselines: publicContractBaselineList(versions, currentId), missing: !found }
  }
  return { previousVersion: candidates[0], baselineSource: 'auto_previous' as const, availableBaselines: publicContractBaselineList(versions, currentId) }
}

function publicContractFieldValue(field: string, value: unknown) {
  if (HASH_ONLY_DIFF_FIELDS.has(field)) return undefined
  if (field === 'routePolicy') return publicRoutePolicy(value)
  return publicSanitize(value ?? null)
}

export function contractDiffSummary(current: any, previous?: any) {
  if (!previous) {
    return {
      comparedWith: null,
      decision: 'baseline' as const,
      changedFields: [],
      breakingFields: [],
      compatibleFields: [],
    }
  }

  const changedFields = CONTRACT_DIFF_FIELDS.flatMap((field) => {
    const beforeHash = evidenceHash(previous?.[field] ?? null)
    const afterHash = evidenceHash(current?.[field] ?? null)
    if (beforeHash === afterHash) return []
    const severity = BREAKING_DIFF_FIELDS.has(field) ? 'breaking' : 'compatible'
    return [{
      field,
      severity,
      beforeHash,
      afterHash,
      before: publicContractFieldValue(field, previous?.[field]),
      after: publicContractFieldValue(field, current?.[field]),
    }]
  })
  const breakingFields = changedFields.filter((item) => item.severity === 'breaking').map((item) => item.field)
  const compatibleFields = changedFields.filter((item) => item.severity === 'compatible').map((item) => item.field)
  return {
    comparedWith: {
      id: String(previous?.id || ''),
      version: previous?.version || null,
      contractHash: previous?.contractHash || skillContractHash(previous),
    },
    decision: breakingFields.length ? 'review_before_upgrade' as const : changedFields.length ? 'safe_to_trial' as const : 'no_change' as const,
    changedFields,
    breakingFields,
    compatibleFields,
  }
}

function contractReviewPlaybook(version: any, opts: PublicSkillContractOptions = {}) {
  const slug = opts.slug ? String(opts.slug) : ''
  const status = String(version?.contractStatus || 'initial')
  const decision =
    status === 'breaking_change'
      ? 'review_before_upgrade'
      : status === 'compatible_change'
        ? 'safe_to_trial'
        : 'baseline'

  return {
    customerValue:
      '把 Skill 从一段 Prompt 变成可复核能力契约：先看输入/输出、权限和最低 Runner，再用 hash 判断版本升级是否会破坏现有流程。',
    decision,
    reviewChecklist: [
      '输入 schema 是否覆盖你的真实任务字段',
      '输出 schema 是否适合自动解析或进入后续工作流',
      '权限与最低 Runner 版本是否符合个人或企业环境',
      'contractHash / promptHash 是否与上次准入记录一致',
    ],
    nextActions: [
      {
        label: '核对契约 Hash',
        description: '用 contractHash 固定输入、输出、权限、推荐模型和 Runner 边界；prompt 正文不公开，只公开 hash 供复核。',
        href: slug ? `/v1/skills/${encodeURIComponent(slug)}/contract` : null,
      },
      {
        label: '检查破坏性变更',
        description:
          status === 'breaking_change'
            ? '本版本改动了 schema、权限或最低 Runner，升级前应先试跑并更新企业准入记录。'
            : '当前未标记破坏性变更，但仍应检查 schema 与权限是否符合你的流程。',
        href: null,
      },
      {
        label: '验签达标证书',
        description: '证书会绑定 Contract、Passport 与黄金样例结果，适合采购、企业 Registry 或上线前复核。',
        href: slug
          ? `/verify?certificateUrl=${encodeURIComponent(`/v1/skills/${encodeURIComponent(slug)}/certificate`)}`
          : null,
      },
      {
        label: '试跑或重跑',
        description: '用默认输入在线试跑，或从私人台账换模型重跑，确认契约在你的模型/网关里仍可用。',
        href: slug ? `/skills/${encodeURIComponent(slug)}/run` : null,
      },
    ],
  }
}

export function publicSkillContract(version: any, opts: PublicSkillContractOptions = {}) {
  const diff = contractDiffSummary(version, opts.previousVersion)
  return {
    id: String(version?.id || ''),
    skill: relationId(version?.skill),
    version: version?.version || null,
    contractHash: version?.contractHash || skillContractHash(version),
    contractStatus: version?.contractStatus || 'initial',
    systemPromptHash: evidenceHash(version?.systemPrompt || ''),
    promptTemplateHash: evidenceHash(version?.promptTemplate || ''),
    inputSchema: publicSanitize(version?.inputSchema || null),
    outputSchema: publicSanitize(version?.outputSchema || null),
    recommendedModels: publicSanitize(version?.recommendedModels || null),
    routePolicy: publicRoutePolicy(version?.routePolicy || null),
    permissions: publicSanitize(version?.permissions || null),
    minRunnerVersion: version?.minRunnerVersion || null,
    examplesCount: Array.isArray(version?.examples) ? version.examples.length : 0,
    changelogHash: version?.changelog ? evidenceHash(version.changelog) : null,
    diff: { ...diff, baselineSource: opts.baselineSource || (opts.previousVersion ? 'auto_previous' : 'none') },
    updatedAt: version?.updatedAt || null,
    playbook: contractReviewPlaybook(version, opts),
  }
}
