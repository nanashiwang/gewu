import type { Payload } from 'payload'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { bucketSize } from './compat'
import { aggregateFailureKnowledge, type FailureKnowledgeGroup, type FailureKnowledgeReport } from './failureKnowledge'
import { resolveRuntimeEnv } from './deploymentSettings'
import { verifyEvidenceSnapshot } from './evidenceSnapshotVerify'
import { getPublicKeyInfo } from './signing'
import { getSkillBenchmarkEvidence } from './benchmarkEvidence'
import { buildSkillCertificate } from './skillCertificate'
import { publicSkillContract } from './skillContractPublic'
import { sanitizeAuditMetadata } from './audit'
import { publicSanitize } from './publicSanitize'
import {
  isUsableSkillVersionForPublicEvidence,
  resolveCurrentSkillVersionForPublicEvidence,
} from './skillVersionPublic'

export type EnterpriseIdentityPolicy = {
  requireSso?: boolean
  domainAllowlist?: string[]
  sso?: {
    enabled?: boolean
    provider?: string
    issuer?: string
    clientId?: string
    discoveryUrl?: string
    authorizationEndpoint?: string
    tokenEndpoint?: string
    jwksUri?: string
  }
  scim?: {
    enabled?: boolean
    baseUrl?: string
    tokenDigest?: string
  }
}

export function normalizeEnterpriseIdentityPolicy(raw: unknown): EnterpriseIdentityPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const input = raw as any
  const rawDomains = input.domainAllowlist || input.domain_allowlist
  const domainAllowlist: string[] | undefined = Array.isArray(rawDomains)
    ? rawDomains
        .map((d: unknown): string => String(d).trim().toLowerCase().replace(/^@/, ''))
        .filter((d: string) => Boolean(d))
    : undefined
  const ssoRaw = input.sso && typeof input.sso === 'object' ? input.sso : {}
  const scimRaw = input.scim && typeof input.scim === 'object' ? input.scim : {}
  const policy: EnterpriseIdentityPolicy = {
    requireSso: input.requireSso === true || input.require_sso === true,
    domainAllowlist: domainAllowlist?.length ? [...new Set(domainAllowlist)] : undefined,
    sso: {
      enabled: ssoRaw.enabled === true || input.ssoEnabled === true || input.sso_enabled === true,
      provider: typeof ssoRaw.provider === 'string' ? ssoRaw.provider.trim() : undefined,
      issuer: typeof ssoRaw.issuer === 'string' ? ssoRaw.issuer.trim() : undefined,
      clientId: typeof ssoRaw.clientId === 'string' ? ssoRaw.clientId.trim() : typeof ssoRaw.client_id === 'string' ? ssoRaw.client_id.trim() : undefined,
      discoveryUrl: typeof ssoRaw.discoveryUrl === 'string' ? ssoRaw.discoveryUrl.trim() : typeof ssoRaw.discovery_url === 'string' ? ssoRaw.discovery_url.trim() : undefined,
      authorizationEndpoint: typeof ssoRaw.authorizationEndpoint === 'string' ? ssoRaw.authorizationEndpoint.trim() : typeof ssoRaw.authorization_endpoint === 'string' ? ssoRaw.authorization_endpoint.trim() : undefined,
      tokenEndpoint: typeof ssoRaw.tokenEndpoint === 'string' ? ssoRaw.tokenEndpoint.trim() : typeof ssoRaw.token_endpoint === 'string' ? ssoRaw.token_endpoint.trim() : undefined,
      jwksUri: typeof ssoRaw.jwksUri === 'string' ? ssoRaw.jwksUri.trim() : typeof ssoRaw.jwks_uri === 'string' ? ssoRaw.jwks_uri.trim() : undefined,
    },
    scim: {
      enabled: scimRaw.enabled === true || input.scimEnabled === true || input.scim_enabled === true,
      baseUrl: typeof scimRaw.baseUrl === 'string' ? scimRaw.baseUrl.trim() : typeof scimRaw.base_url === 'string' ? scimRaw.base_url.trim() : undefined,
      tokenDigest: typeof scimRaw.tokenDigest === 'string' ? scimRaw.tokenDigest.trim() : typeof scimRaw.token_digest === 'string' ? scimRaw.token_digest.trim() : undefined,
    },
  }
  if (!policy.sso?.enabled && !policy.sso?.provider && !policy.sso?.issuer && !policy.sso?.clientId && !policy.sso?.discoveryUrl && !policy.sso?.authorizationEndpoint && !policy.sso?.tokenEndpoint && !policy.sso?.jwksUri) delete policy.sso
  if (!policy.scim?.enabled && !policy.scim?.baseUrl && !policy.scim?.tokenDigest) delete policy.scim
  if (!policy.requireSso) delete policy.requireSso
  return Object.keys(policy).length ? policy : undefined
}


export type EnterpriseIdentityPolicyIssue = { level: 'blocker' | 'warning'; code: string; message: string }

function isHttpsUrl(value?: string) {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

function validDomain(value: string) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) && !value.includes('..')
}

export function validateEnterpriseIdentityPolicy(rawPolicy: unknown): EnterpriseIdentityPolicyIssue[] {
  const policy = normalizeEnterpriseIdentityPolicy(rawPolicy)
  if (!policy) return []
  const issues: EnterpriseIdentityPolicyIssue[] = []
  for (const domain of policy.domainAllowlist || []) {
    if (!validDomain(domain)) issues.push({ level: 'blocker', code: 'DOMAIN_ALLOWLIST_INVALID', message: `邮箱域格式无效：${domain}` })
  }
  const sso = policy.sso
  if (policy.requireSso && !sso?.enabled) {
    issues.push({ level: 'blocker', code: 'SSO_REQUIRED_BUT_DISABLED', message: '已要求 SSO 登录，但未启用 SSO 配置' })
  }
  if (sso?.enabled) {
    const provider = String(sso.provider || '').toLowerCase()
    if (!provider) issues.push({ level: 'blocker', code: 'SSO_PROVIDER_MISSING', message: '启用 SSO 时必须声明 provider' })
    if (provider && !['oidc', 'saml', 'okta', 'azuread', 'google'].includes(provider)) {
      issues.push({ level: 'warning', code: 'SSO_PROVIDER_CUSTOM', message: `未内置识别的 SSO provider：${sso.provider}` })
    }
    if (provider === 'oidc' || provider === 'okta' || provider === 'azuread' || provider === 'google') {
      if (!sso.issuer) issues.push({ level: 'blocker', code: 'OIDC_ISSUER_MISSING', message: 'OIDC SSO 必须配置 issuer' })
      if (!sso.clientId) issues.push({ level: 'blocker', code: 'OIDC_CLIENT_ID_MISSING', message: 'OIDC SSO 必须配置 clientId' })
    }
    for (const [key, value] of Object.entries({
      issuer: sso.issuer,
      discoveryUrl: sso.discoveryUrl,
      authorizationEndpoint: sso.authorizationEndpoint,
      tokenEndpoint: sso.tokenEndpoint,
      jwksUri: sso.jwksUri,
    })) {
      if (!isHttpsUrl(value)) issues.push({ level: 'blocker', code: 'SSO_URL_INVALID', message: `${key} 必须是 HTTPS URL：${value}` })
    }
  }
  const scim = policy.scim
  if (scim?.enabled) {
    if (!scim.baseUrl) issues.push({ level: 'blocker', code: 'SCIM_BASE_URL_MISSING', message: '启用 SCIM 时必须配置 baseUrl' })
    if (!isHttpsUrl(scim.baseUrl)) issues.push({ level: 'blocker', code: 'SCIM_BASE_URL_INVALID', message: `SCIM baseUrl 必须是 HTTPS URL：${scim.baseUrl}` })
    if (!/^sha256:[a-f0-9]{64}$/i.test(scim.tokenDigest || '')) {
      issues.push({ level: 'blocker', code: 'SCIM_TOKEN_DIGEST_INVALID', message: 'SCIM tokenDigest 必须是 sha256:<64位hex>' })
    }
  }
  return issues
}

export function evaluateEnterpriseIdentityPolicy(
  rawPolicy: unknown,
  context: { email?: string; authMethod?: 'password' | 'sso' | 'scim' | string } = {},
): { ok: true } | { ok: false; reason: string } {
  const policy = normalizeEnterpriseIdentityPolicy(rawPolicy)
  if (!policy) return { ok: true }
  const email = String(context.email || '').trim().toLowerCase()
  const domain = email.includes('@') ? email.split('@').pop() || '' : ''
  if (policy.domainAllowlist?.length && (!domain || !policy.domainAllowlist.includes(domain))) {
    return { ok: false, reason: `邮箱域 ${domain || 'unknown'} 不在组织允许范围内` }
  }
  if (policy.requireSso && !['sso', 'scim'].includes(String(context.authMethod || ''))) {
    return { ok: false, reason: '组织身份策略要求 SSO 登录' }
  }
  return { ok: true }
}

export function enterpriseScimTokenDigest(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}

export function verifyEnterpriseScimToken(policy: unknown, token?: string | null): { ok: true } | { ok: false; reason: string } {
  const normalized = normalizeEnterpriseIdentityPolicy(policy)
  if (!normalized?.scim?.enabled) return { ok: false, reason: '组织未启用 SCIM' }
  const expected = normalized.scim.tokenDigest
  if (!expected) return { ok: false, reason: '组织未配置 SCIM tokenDigest' }
  const actual = enterpriseScimTokenDigest(String(token || '').replace(/^Bearer\s+/i, '').trim())
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'SCIM token 无效' }
  return { ok: true }
}

export function publicEnterpriseIdentityPolicy(rawPolicy: unknown): EnterpriseIdentityPolicy | undefined {
  const policy = normalizeEnterpriseIdentityPolicy(rawPolicy)
  if (!policy) return undefined
  const safe: EnterpriseIdentityPolicy = { ...policy }
  if (policy.sso) safe.sso = { ...policy.sso }
  if (policy.scim) {
    const { tokenDigest: _tokenDigest, ...scim } = policy.scim
    safe.scim = {
      ...scim,
      ...(policy.scim.tokenDigest ? { tokenDigest: 'configured' } : {}),
    }
  }
  return safe
}

export function publicEnterpriseOrganization(org: any) {
  if (!org) return null
  return {
    id: String(org.id || ''),
    name: org.name || null,
    slug: org.slug || null,
    owner: publicRelationRef(org.owner),
    plan: org.plan || 'team',
    status: org.status || 'active',
    modelAllowlist: publicSanitize(org.modelAllowlist || null),
    policy: publicSanitize(org.policy || null),
    identityPolicy: publicEnterpriseIdentityPolicy(org.identityPolicy) || null,
    createdAt: org.createdAt || undefined,
    updatedAt: org.updatedAt || undefined,
  }
}

function publicRelationRef(value: any) {
  if (!value) return null
  if (typeof value === 'object') {
    return {
      id: String(value.id || ''),
      email: value.email || undefined,
      username: value.username || undefined,
      name: value.name || value.title || undefined,
      slug: value.slug || undefined,
    }
  }
  return { id: String(value) }
}

export function publicEnterpriseMember(member: any) {
  if (!member) return null
  return {
    id: String(member.id || ''),
    organization: publicRelationRef(member.organization),
    user: publicRelationRef(member.user),
    role: member.role || 'member',
    status: member.status || 'active',
    createdAt: member.createdAt || undefined,
    updatedAt: member.updatedAt || undefined,
  }
}

function enterpriseRegistryPlaybook(registry: any) {
  const status = String(registry?.approvalStatus || 'pending')
  const decision =
    status === 'approved'
      ? 'allow'
      : status === 'rejected' || status === 'revoked'
        ? 'block'
        : 'review'
  const modelCount = Array.isArray(registry?.modelAllowlist)
    ? registry.modelAllowlist.length
    : Array.isArray(registry?.modelAllowlist?.models)
      ? registry.modelAllowlist.models.length
      : 0
  return {
    customerValue:
      '企业 Registry 把 Skill 准入从“谁能用”变成可审计治理链：批准 Skill、绑定模型/审计策略、读取组织内 Passport、运行后沉淀审计和企业失败库。',
    decision,
    nextActions: [
      {
        label: '复核证据',
        description:
          '先看组织内 Passport、达标证书和证据验签摘要；证书未 passed 时需要风险确认或继续人工复核。',
      },
      {
        label: '绑定模型白名单',
        description: modelCount > 0
          ? `已限制 ${modelCount} 个模型，运行时会按组织准入边界检查。`
          : '尚未限制模型，建议按已验证模型版本设置白名单。',
      },
      {
        label: '执行运行授权',
        description:
          decision === 'allow'
            ? '已批准 Registry 可进入企业运行授权；仍会执行审计策略、输入规模和 BYOK 等边界。'
            : '未批准前不应让普通成员使用该 Skill。',
      },
      {
        label: '留审计并查失败库',
        description:
          '企业运行、策略拒绝和失败会进入审计；后续可聚合组织内失败知识库，不暴露员工输入输出原文。',
      },
    ],
  }
}

export function publicEnterpriseRegistry(registry: any) {
  if (!registry) return null
  return {
    id: String(registry.id || ''),
    name: registry.name || null,
    organization: publicRelationRef(registry.organization),
    skill: publicRelationRef(registry.skill),
    skillVersion: publicRelationRef(registry.skillVersion),
    passport: publicRelationRef(registry.passport),
    approvalStatus: registry.approvalStatus || 'pending',
    approvedBy: publicRelationRef(registry.approvedBy),
    approvedAt: registry.approvedAt || null,
    modelAllowlist: publicSanitize(registry.modelAllowlist || null),
    usageScope: registry.usageScope || null,
    riskNotes: registry.riskNotes || null,
    auditPolicy: publicSanitize(registry.auditPolicy || null),
    playbook: publicSanitize(enterpriseRegistryPlaybook(registry)),
    createdAt: registry.createdAt || undefined,
    updatedAt: registry.updatedAt || undefined,
  }
}

function usernameFromEmail(email: string) {
  const base = email.split('@')[0]?.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24) || 'scim-user'
  return `${base}-${randomBytes(3).toString('hex')}`
}

function scimPatchValue(body: any, path: string) {
  const ops = Array.isArray(body?.Operations) ? body.Operations : Array.isArray(body?.operations) ? body.operations : []
  const op = ops.find((item: any) => String(item?.path || '').toLowerCase() === path.toLowerCase())
  if (!op) return undefined
  if (op.value && typeof op.value === 'object' && !Array.isArray(op.value)) return op.value[path]
  return op.value
}

export function normalizeEnterpriseScimUserInput(body: any): {
  email: string
  username?: string
  role?: string
  active: boolean
} {
  const emails = Array.isArray(body?.emails) ? body.emails : []
  const primaryEmail = emails.find((e: any) => e?.primary && typeof e?.value === 'string') || emails.find((e: any) => typeof e?.value === 'string')
  const roles = Array.isArray(body?.roles) ? body.roles : []
  const primaryRole = roles.find((r: any) => r?.primary && typeof r?.value === 'string') || roles.find((r: any) => typeof r?.value === 'string')
  const patchedActive = scimPatchValue(body, 'active')
  const patchedUserName = scimPatchValue(body, 'userName')
  return {
    email: String(body?.email || primaryEmail?.value || patchedUserName || body?.userName || '').trim(),
    username: typeof body?.displayName === 'string' ? body.displayName.trim() : typeof body?.name?.formatted === 'string' ? body.name.formatted.trim() : undefined,
    role: typeof body?.role === 'string' ? body.role.trim() : typeof primaryRole?.value === 'string' ? primaryRole.value.trim() : undefined,
    active: patchedActive === undefined ? body?.active !== false : patchedActive !== false,
  }
}

export function enterpriseScimUserResource(user: any, member?: any | null) {
  const email = String(user?.email || user?.userName || '')
  const role = member?.role ? String(member.role) : undefined
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: String(user?.id || ''),
    userName: email,
    active: member?.status !== 'suspended' && user?.accountStatus !== 'banned',
    displayName: user?.username || undefined,
    emails: email ? [{ value: email, primary: true }] : [],
    roles: role ? [{ value: role, primary: true }] : [],
    meta: { resourceType: 'User' },
  }
}

export function enterpriseScimListResponse(resources: any[], totalResults = resources.length, startIndex = 1, itemsPerPage = resources.length) {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources: resources,
  }
}


export function parseEnterpriseScimUserFilter(filter?: string | null): { email?: string; unsupported?: string } {
  const raw = String(filter || '').trim()
  if (!raw) return {}
  const match = raw.match(/^(?:userName|email|emails\.value)\s+eq\s+"([^"]+)"$/i)
  if (!match) return { unsupported: raw }
  return { email: match[1].trim() }
}

export function modelAllowedByRegistry(allowlist: unknown, modelName?: string): boolean {
  if (!modelName) return true
  if (!allowlist) return true
  if (Array.isArray(allowlist)) return allowlist.length === 0 || allowlist.includes(modelName)
  if (typeof allowlist === 'object') {
    const models = (allowlist as any).models
    if (Array.isArray(models)) return models.length === 0 || models.includes(modelName)
  }
  return true
}


export const ENTERPRISE_POLICY_TEMPLATES = {
  balanced: {
    label: '均衡默认',
    description: '允许常规输入规模和常用路由，适合大多数团队试点。',
    policy: { maxInputChars: 20_000, allowedRouteModes: ['balanced', 'quality', 'fast'] },
  },
  strict_byok: {
    label: '强隐私 BYOK',
    description: '要求员工使用自带 Key，并限制超大输入。',
    policy: { requireByok: true, maxInputChars: 10_000, blockedRouteModes: ['cheap'] },
  },
  low_risk: {
    label: '低风险试用',
    description: '仅允许小输入规模和均衡/快速路由，适合新 Skill 灰度。',
    policy: { maxInputChars: 5_000, allowedInputBuckets: ['0-100', '100-500', '500-2k'], allowedRouteModes: ['balanced', 'fast'] },
  },
} as const

export type EnterprisePolicyTemplateKey = keyof typeof ENTERPRISE_POLICY_TEMPLATES

export function enterprisePolicyFromTemplate(template?: string | null): Record<string, unknown> | undefined {
  const key = String(template || '').trim() as EnterprisePolicyTemplateKey
  const item = ENTERPRISE_POLICY_TEMPLATES[key]
  return item ? { ...item.policy } : undefined
}

export function listEnterprisePolicyTemplates() {
  return Object.entries(ENTERPRISE_POLICY_TEMPLATES).map(([key, value]) => ({ key, ...value }))
}

export function mergeEnterprisePolicy(template?: string | null, policy?: unknown) {
  const base = enterprisePolicyFromTemplate(template) || {}
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return Object.keys(base).length ? base : undefined
  return { ...base, ...(policy as Record<string, unknown>) }
}

export function evaluateEnterprisePolicy(
  policy: any,
  context: { input?: Record<string, unknown>; routeMode?: string; byok?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return { ok: true }
  const inputLength = context.input ? JSON.stringify(context.input).length : undefined
  const inputBucket = inputLength == null ? undefined : bucketSize(inputLength)
  const maxInputChars = Number(policy.maxInputChars ?? policy.max_input_chars)
  if (Number.isFinite(maxInputChars) && inputLength != null && inputLength > maxInputChars) {
    return { ok: false, reason: `输入长度 ${inputLength} 超过企业策略上限 ${maxInputChars}` }
  }
  const allowedInputBuckets = Array.isArray(policy.allowedInputBuckets) ? policy.allowedInputBuckets : undefined
  if (allowedInputBuckets?.length && inputBucket && !allowedInputBuckets.includes(inputBucket)) {
    return { ok: false, reason: `输入规模档 ${inputBucket} 不在企业允许范围内` }
  }
  const blockedInputBuckets = Array.isArray(policy.blockedInputBuckets) ? policy.blockedInputBuckets : undefined
  if (blockedInputBuckets?.includes(inputBucket)) {
    return { ok: false, reason: `输入规模档 ${inputBucket} 被企业策略禁止` }
  }
  const allowedRouteModes = Array.isArray(policy.allowedRouteModes) ? policy.allowedRouteModes : undefined
  if (allowedRouteModes?.length && context.routeMode && !allowedRouteModes.includes(context.routeMode)) {
    return { ok: false, reason: `路由模式 ${context.routeMode} 不在企业允许范围内` }
  }
  const blockedRouteModes = Array.isArray(policy.blockedRouteModes) ? policy.blockedRouteModes : undefined
  if (blockedRouteModes?.includes(context.routeMode)) {
    return { ok: false, reason: `路由模式 ${context.routeMode} 被企业策略禁止` }
  }
  if (policy.requireByok === true && !context.byok) {
    return { ok: false, reason: '企业策略要求使用 BYOK 运行' }
  }
  return { ok: true }
}

export async function canUseEnterpriseSkill(
  payload: Payload,
  args: { userId: string; organizationId?: string; skillId: string; modelName?: string; input?: Record<string, unknown>; routeMode?: string; byok?: boolean },
): Promise<{ ok: true; registryId?: string } | { ok: false; reason: string }> {
  if (!args.organizationId) return { ok: false, reason: '缺少组织上下文' }
  const org = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org || org.status === 'suspended') return { ok: false, reason: '组织不存在或已暂停' }
  const ownerId = typeof org.owner === 'object' ? org.owner?.id : org.owner
  let memberOk = String(ownerId || '') === String(args.userId)
  if (!memberOk) {
    const members = await payload.find({
      collection: 'organization-members' as any,
      where: {
        and: [
          { organization: { equals: args.organizationId } },
          { user: { equals: args.userId } },
          { status: { equals: 'active' } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    memberOk = members.totalDocs > 0
  }
  if (!memberOk) return { ok: false, reason: '你不是该组织成员' }

  const regs = await payload.find({
    collection: 'enterprise-registries' as any,
    where: {
      and: [
        { organization: { equals: args.organizationId } },
        { skill: { equals: args.skillId } },
        { approvalStatus: { equals: 'approved' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const registry = regs.docs[0] as any
  if (!registry) return { ok: false, reason: '该 Skill 尚未被组织批准' }
  if (!modelAllowedByRegistry(registry.modelAllowlist || org.modelAllowlist, args.modelName)) {
    return { ok: false, reason: `模型 ${args.modelName} 不在组织白名单内` }
  }
  const policy = evaluateEnterprisePolicy(registry.auditPolicy || org.policy, {
    input: args.input,
    routeMode: args.routeMode,
    byok: args.byok,
  })
  if (!policy.ok) return policy
  return { ok: true, registryId: String(registry.id) }
}

export async function canAccessEnterpriseSkill(
  payload: Payload,
  args: { userId: string; organizationId?: string; skillId: string },
): Promise<{ ok: true; registryId?: string } | { ok: false; reason: string }> {
  if (!args.organizationId) return { ok: false, reason: '缺少组织上下文' }
  const org = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org || org.status === 'suspended') return { ok: false, reason: '组织不存在或已暂停' }
  const ownerId = typeof org.owner === 'object' ? org.owner?.id : org.owner
  let memberOk = String(ownerId || '') === String(args.userId)
  if (!memberOk) {
    const members = await payload.find({
      collection: 'organization-members' as any,
      where: {
        and: [
          { organization: { equals: args.organizationId } },
          { user: { equals: args.userId } },
          { status: { equals: 'active' } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    memberOk = members.totalDocs > 0
  }
  if (!memberOk) return { ok: false, reason: '你不是该组织成员' }

  const regs = await payload.find({
    collection: 'enterprise-registries' as any,
    where: {
      and: [
        { organization: { equals: args.organizationId } },
        { skill: { equals: args.skillId } },
        { approvalStatus: { equals: 'approved' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const registry = regs.docs[0] as any
  if (!registry) return { ok: false, reason: '该 Skill 尚未被组织批准' }
  return { ok: true, registryId: String(registry.id) }
}

export async function canReadEnterpriseAudit(
  payload: Payload,
  args: { userId: string; userRole?: string; organizationId?: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!args.organizationId) return { ok: false, reason: '缺少组织上下文' }
  if (args.userRole === 'admin') return { ok: true }
  const org = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org || org.status === 'suspended') return { ok: false, reason: '组织不存在或已暂停' }
  const ownerId = typeof org.owner === 'object' ? org.owner?.id : org.owner
  if (String(ownerId || '') === String(args.userId)) return { ok: true }
  const members = await payload.find({
    collection: 'organization-members' as any,
    where: {
      and: [
        { organization: { equals: args.organizationId } },
        { user: { equals: args.userId } },
        { status: { equals: 'active' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const member = members.docs[0] as any
  if (member && ['admin', 'auditor', 'approver'].includes(String(member.role))) return { ok: true }
  return { ok: false, reason: '你没有企业审计权限' }
}

function csvCell(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function enterpriseAuditRowsToCsv(rows: any[]): string {
  const headers = [
    'createdAt',
    'organization',
    'registry',
    'actor',
    'skill',
    'skillVersion',
    'runId',
    'modelName',
    'modelVersion',
    'modelProfile',
    'outcome',
    'errorCode',
    'policyReason',
    'inputSizeBucket',
    'outputSizeBucket',
    'latencyMs',
    'estimatedCost',
    'chargedCredits',
  ]
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(','))
  }
  return `${lines.join('\n')}\n`
}

export async function exportEnterpriseAuditCsv(
  payload: Payload,
  args: { organizationId: string; limit?: number },
): Promise<string> {
  const res = await payload.find({
    collection: 'enterprise-audit-logs' as any,
    where: { organization: { equals: args.organizationId } },
    limit: Math.min(Math.max(args.limit || 1000, 1), 5000),
    depth: 0,
    sort: '-createdAt',
    overrideAccess: true,
  })
  return enterpriseAuditRowsToCsv(res.docs as any[])
}


export type EnterpriseManageRole = 'platform_admin' | 'owner' | 'admin' | 'approver'

export async function canManageOrganization(
  payload: Payload,
  args: { userId: string; userRole?: string; organizationId?: string; roles?: EnterpriseManageRole[] },
): Promise<{ ok: true; role: EnterpriseManageRole } | { ok: false; reason: string }> {
  if (!args.organizationId) return { ok: false, reason: '缺少组织上下文' }
  const allowed = args.roles || ['platform_admin', 'owner', 'admin']
  const org = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org || org.status === 'suspended') return { ok: false, reason: '组织不存在或已暂停' }
  if (args.userRole === 'admin' && allowed.includes('platform_admin')) return { ok: true, role: 'platform_admin' }
  const ownerId = typeof org.owner === 'object' ? org.owner?.id : org.owner
  if (String(ownerId || '') === String(args.userId) && allowed.includes('owner')) return { ok: true, role: 'owner' }

  const members = await payload.find({
    collection: 'organization-members' as any,
    where: {
      and: [
        { organization: { equals: args.organizationId } },
        { user: { equals: args.userId } },
        { status: { equals: 'active' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const memberRole = String((members.docs[0] as any)?.role || '') as EnterpriseManageRole
  if (memberRole && allowed.includes(memberRole)) return { ok: true, role: memberRole }
  return { ok: false, reason: '你没有组织管理权限' }
}

const REGISTRY_STATUSES = new Set(['pending', 'approved', 'restricted', 'disabled', 'deprecated'])

export async function upsertEnterpriseRegistry(
  payload: Payload,
  args: {
    actorId: string
    actorRole?: string
    organizationId: string
    skillId: string
    registryId?: string
    skillVersionId?: string
    passportId?: string
    approvalStatus?: string
    modelAllowlist?: unknown
    usageScope?: string
    riskNotes?: string
    auditPolicy?: unknown
    policyTemplate?: string
    enforceCertificateGate?: boolean
    certificateRiskAccepted?: boolean
  },
): Promise<{ ok: true; registry: any; created: boolean; certificateSummary?: any } | { ok: false; reason: string; certificateSummary?: any }> {
  const access = await canManageOrganization(payload, {
    userId: args.actorId,
    userRole: args.actorRole,
    organizationId: args.organizationId,
    roles: ['platform_admin', 'owner', 'admin', 'approver'],
  })
  if (!access.ok) return access
  const approvalStatus = args.approvalStatus || 'approved'
  if (!REGISTRY_STATUSES.has(approvalStatus)) return { ok: false, reason: '审批状态无效' }

  const skill = await payload
    .findByID({ collection: 'skills' as any, id: args.skillId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!skill) return { ok: false, reason: 'Skill 不存在' }

  const certificateSummary =
    approvalStatus === 'approved' && args.enforceCertificateGate
      ? await getEnterpriseApprovalCertificateSummary(payload, {
          skill,
          skillId: args.skillId,
          skillVersionId: args.skillVersionId,
          passportId: args.passportId,
        }).catch((e) => ({
          status: 'provisional',
          statusReasons: ['certificate_check_failed'],
          signed: false,
          error: (e as Error).message,
        }))
      : undefined
  if (
    approvalStatus === 'approved' &&
    args.enforceCertificateGate &&
    certificateSummary?.status !== 'passed' &&
    !args.certificateRiskAccepted
  ) {
    return {
      ok: false,
      reason: '该 Skill 尚未正式达标；如确需灰度批准，请先勾选风险确认',
      certificateSummary,
    }
  }

  let existing: any = null
  if (args.registryId) {
    existing = await payload
      .findByID({ collection: 'enterprise-registries' as any, id: args.registryId, depth: 0, overrideAccess: true })
      .catch(() => null)
    if (!existing) return { ok: false, reason: '企业注册记录不存在' }
    const existingOrg = typeof existing.organization === 'object' ? existing.organization?.id : existing.organization
    if (String(existingOrg) !== String(args.organizationId)) return { ok: false, reason: '注册记录不属于该组织' }
  } else {
    const found = await payload.find({
      collection: 'enterprise-registries' as any,
      where: { and: [{ organization: { equals: args.organizationId } }, { skill: { equals: args.skillId } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    existing = found.docs[0] as any
  }

  const data: Record<string, unknown> = {
    name: existing?.name || `${skill.title || 'Skill'} 企业准入`,
    organization: args.organizationId,
    skill: args.skillId,
    approvalStatus,
    skillVersion: args.skillVersionId,
    passport: args.passportId,
    modelAllowlist: args.modelAllowlist,
    usageScope: args.usageScope,
    riskNotes: args.riskNotes,
    auditPolicy: mergeEnterprisePolicy(args.policyTemplate, args.auditPolicy),
  }
  if (approvalStatus === 'approved') {
    data.approvedBy = args.actorId
    data.approvedAt = new Date().toISOString()
  }
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k])

  if (existing) {
    const registry = await payload.update({
      collection: 'enterprise-registries' as any,
      id: existing.id,
      data,
      depth: 0,
      overrideAccess: true,
    })
    return { ok: true, registry, created: false, certificateSummary }
  }
  const registry = await payload.create({
    collection: 'enterprise-registries' as any,
    data,
    depth: 0,
    overrideAccess: true,
  })
  return { ok: true, registry, created: true, certificateSummary }
}

export async function getEnterpriseApprovalCertificateSummary(
  payload: Payload,
  args: { skill: any; skillId: string; skillVersionId?: string; passportId?: string },
) {
  const skill = args.skill
  const passport = args.passportId
    ? await payload.findByID({ collection: 'skill-passports' as any, id: args.passportId, depth: 0, overrideAccess: true }).catch(() => null)
    : (
        await payload.find({
          collection: 'skill-passports' as any,
          where: {
            and: [{ skill: { equals: args.skillId } }, { status: { equals: 'current' } }],
          },
          sort: '-lastVerifiedAt',
          limit: 1,
          depth: 0,
          overrideAccess: true,
        })
      ).docs[0]
  if (!passport) return { status: 'provisional', statusReasons: ['passport_not_current'], signed: false }
  const passportSkillId = relationId((passport as any).skill)
  if (passportSkillId && passportSkillId !== String(args.skillId)) {
    return { status: 'failed', statusReasons: ['passport_skill_mismatch'], signed: false }
  }
  const explicitVersion = args.skillVersionId
    ? await payload
        .findByID({ collection: 'skill-versions' as any, id: String(args.skillVersionId), depth: 0, overrideAccess: true })
        .catch(() => null)
    : null
  const version = args.skillVersionId
    ? explicitVersion
    : await resolveCurrentSkillVersionForPublicEvidence(payload, skill)
  if (!version || !isUsableSkillVersionForPublicEvidence(skill, version)) {
    return { status: 'failed', statusReasons: ['contract_version_invalid'], signed: false }
  }
  const [snapshotRes, runtimeEnv, benchmarkEvidence] = await Promise.all([
    payload.find({
      collection: 'evidence-snapshots' as any,
      where: { and: [{ targetType: { equals: 'skill_passport' } }, { targetId: { equals: String((passport as any).id) } }] },
      limit: 1,
      depth: 0,
      sort: '-createdAt',
      overrideAccess: true,
    }),
    resolveRuntimeEnv(payload),
    getSkillBenchmarkEvidence(payload, args.skillId),
  ])
  const publicKey = getPublicKeyInfo(runtimeEnv)
  const snapshot = (snapshotRes.docs as any[])[0] || null
  const evidenceVerify = snapshot ? verifyEvidenceSnapshot(snapshot, publicKey) : null
  const certificate = buildSkillCertificate(
    {
      skill: { id: String(skill.id), slug: String(skill.slug || ''), title: String(skill.title || '') },
      passport,
      contractSummary: version ? publicSkillContract(version) : null,
      benchmarkSummary: benchmarkEvidence,
      evidenceSnapshotVerify: evidenceVerify,
    },
    runtimeEnv,
  )
  return {
    status: certificate.certificate.status,
    statusReasons: certificate.certificate.statusReasons,
    certificateHash: certificate.certificate.certificateHash,
    signed: Boolean(certificate.certificateSignature),
  }
}

export async function updateEnterpriseIdentityPolicy(
  payload: Payload,
  args: {
    actorId: string
    actorRole?: string
    organizationId: string
    identityPolicy?: unknown
  },
): Promise<{ ok: true; organization: any; identityPolicy: EnterpriseIdentityPolicy | undefined } | { ok: false; reason: string }> {
  const access = await canManageOrganization(payload, {
    userId: args.actorId,
    userRole: args.actorRole,
    organizationId: args.organizationId,
    roles: ['platform_admin', 'owner', 'admin'],
  })
  if (!access.ok) return access
  const existing = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  const previousPolicy = normalizeEnterpriseIdentityPolicy(existing?.identityPolicy)
  const identityPolicy = normalizeEnterpriseIdentityPolicy(args.identityPolicy)
  if (identityPolicy?.scim && identityPolicy.scim.tokenDigest === 'configured') {
    identityPolicy.scim.tokenDigest = previousPolicy?.scim?.tokenDigest
  }
  const blockers = validateEnterpriseIdentityPolicy(identityPolicy).filter((issue) => issue.level === 'blocker')
  if (blockers.length) return { ok: false, reason: blockers[0].message }
  const organization = await payload.update({
    collection: 'organizations' as any,
    id: args.organizationId,
    data: { identityPolicy: identityPolicy || null },
    depth: 0,
    overrideAccess: true,
  })
  return {
    ok: true,
    organization: publicEnterpriseOrganization(organization),
    identityPolicy: publicEnterpriseIdentityPolicy(identityPolicy),
  }
}

export async function upsertOrganizationMember(
  payload: Payload,
  args: {
    actorId: string
    actorRole?: string
    organizationId: string
    userId: string
    role?: string
    status?: string
    authMethod?: 'password' | 'sso' | 'scim' | string
  },
): Promise<{ ok: true; member: any; created: boolean } | { ok: false; reason: string }> {
  const access = await canManageOrganization(payload, {
    userId: args.actorId,
    userRole: args.actorRole,
    organizationId: args.organizationId,
    roles: ['platform_admin', 'owner', 'admin'],
  })
  if (!access.ok) return access
  const role = args.role || 'member'
  if (!['member', 'approver', 'auditor', 'admin'].includes(role)) return { ok: false, reason: '成员角色无效' }
  const status = args.status || 'active'
  if (!['active', 'suspended'].includes(status)) return { ok: false, reason: '成员状态无效' }

  const org = await payload.findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true }) as any
  const ownerId = typeof org.owner === 'object' ? org.owner?.id : org.owner
  if (String(ownerId || '') === String(args.userId)) return { ok: false, reason: '组织负责人不需要作为普通成员维护' }
  const target = await payload
    .findByID({ collection: 'users' as any, id: args.userId, depth: 0, overrideAccess: true })
    .catch(() => null)
  if (!target) return { ok: false, reason: '用户不存在' }
  if (status === 'active') {
    const identity = evaluateEnterpriseIdentityPolicy(org.identityPolicy, {
      email: (target as any).email,
      authMethod: args.authMethod || 'password',
    })
    if (!identity.ok) return identity
  }

  const found = await payload.find({
    collection: 'organization-members' as any,
    where: { and: [{ organization: { equals: args.organizationId } }, { user: { equals: args.userId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const existing = found.docs[0] as any
  const data = { organization: args.organizationId, user: args.userId, role, status }
  if (existing) {
    const member = await payload.update({
      collection: 'organization-members' as any,
      id: existing.id,
      data,
      depth: 0,
      overrideAccess: true,
    })
    return { ok: true, member, created: false }
  }
  const member = await payload.create({
    collection: 'organization-members' as any,
    data,
    depth: 0,
    overrideAccess: true,
  })
  return { ok: true, member, created: true }
}

export async function suspendOrganizationMember(
  payload: Payload,
  args: { actorId: string; actorRole?: string; organizationId: string; userId: string },
): Promise<{ ok: true; member: any } | { ok: false; reason: string }> {
  const result = await upsertOrganizationMember(payload, { ...args, role: 'member', status: 'suspended' })
  if (!result.ok) return result
  return { ok: true, member: result.member }
}

export async function provisionEnterpriseScimMember(
  payload: Payload,
  args: {
    organizationId: string
    bearerToken?: string | null
    email: string
    username?: string
    role?: string
    active?: boolean
  },
): Promise<{ ok: true; user: any; member: any; createdUser: boolean; createdMember?: boolean } | { ok: false; reason: string }> {
  const org = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org || org.status === 'suspended') return { ok: false, reason: '组织不存在或已暂停' }
  const token = verifyEnterpriseScimToken(org.identityPolicy, args.bearerToken)
  if (!token.ok) return token

  const email = String(args.email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, reason: 'SCIM 用户缺少合法 email' }
  const identity = evaluateEnterpriseIdentityPolicy(org.identityPolicy, { email, authMethod: 'scim' })
  if (!identity.ok) return identity

  const found = await payload.find({
    collection: 'users' as any,
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  let user = found.docs[0] as any
  let createdUser = false
  if (!user) {
    user = await payload.create({
      collection: 'users' as any,
      data: {
        email,
        username: args.username?.trim() || usernameFromEmail(email),
        password: randomBytes(18).toString('base64url'),
        role: 'user',
        accountStatus: 'active',
      },
      depth: 0,
      overrideAccess: true,
    })
    createdUser = true
  }

  const ownerId = typeof org.owner === 'object' ? org.owner?.id : org.owner
  if (String(ownerId || '') === String(user.id)) return { ok: false, reason: '组织负责人不需要作为普通成员维护' }
  const result = await upsertOrganizationMember(payload, {
    actorId: String(ownerId || ''),
    organizationId: args.organizationId,
    userId: String(user.id),
    role: args.role || 'member',
    status: args.active === false ? 'suspended' : 'active',
    authMethod: 'scim',
  })
  if (!result.ok) return result
  return { ok: true, user, member: result.member, createdUser, createdMember: result.created }
}

async function scimAuthorizedOrganization(
  payload: Payload,
  args: { organizationId: string; bearerToken?: string | null },
): Promise<{ ok: true; organization: any } | { ok: false; reason: string }> {
  const org = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org || org.status === 'suspended') return { ok: false, reason: '组织不存在或已暂停' }
  const token = verifyEnterpriseScimToken(org.identityPolicy, args.bearerToken)
  if (!token.ok) return token
  return { ok: true, organization: org }
}


export async function listEnterpriseScimMembers(
  payload: Payload,
  args: { organizationId: string; bearerToken?: string | null; startIndex?: number; count?: number },
): Promise<{ ok: true; resources: any[]; totalResults: number; startIndex: number; itemsPerPage: number } | { ok: false; reason: string }> {
  const auth = await scimAuthorizedOrganization(payload, args)
  if (!auth.ok) return auth
  const startIndex = Math.max(Number(args.startIndex || 1), 1)
  const count = Math.min(Math.max(Number(args.count || 50), 1), 200)
  const res = await payload.find({
    collection: 'organization-members' as any,
    where: { organization: { equals: args.organizationId } },
    limit: count,
    page: Math.ceil(startIndex / count),
    depth: 1,
    overrideAccess: true,
  })
  const resources = []
  for (const member of res.docs as any[]) {
    let user = typeof member.user === 'object' ? member.user : null
    if (!user && member.user) {
      user = await payload.findByID({ collection: 'users' as any, id: String(member.user), depth: 0, overrideAccess: true }).catch(() => null)
    }
    if (user) resources.push(enterpriseScimUserResource(user, member))
  }
  return {
    ok: true,
    resources,
    totalResults: Number(res.totalDocs || resources.length),
    startIndex,
    itemsPerPage: resources.length,
  }
}

export async function findEnterpriseScimMember(
  payload: Payload,
  args: { organizationId: string; bearerToken?: string | null; email: string },
): Promise<{ ok: true; user: any | null; member: any | null } | { ok: false; reason: string }> {
  const auth = await scimAuthorizedOrganization(payload, args)
  if (!auth.ok) return auth
  const email = String(args.email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, reason: 'SCIM 用户缺少合法 email' }
  const users = await payload.find({
    collection: 'users' as any,
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const user = users.docs[0] as any
  if (!user) return { ok: true, user: null, member: null }
  const members = await payload.find({
    collection: 'organization-members' as any,
    where: { and: [{ organization: { equals: args.organizationId } }, { user: { equals: user.id } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return { ok: true, user, member: (members.docs[0] as any) || null }
}

export async function deprovisionEnterpriseScimMember(
  payload: Payload,
  args: { organizationId: string; bearerToken?: string | null; email: string },
): Promise<{ ok: true; user: any | null; member: any | null } | { ok: false; reason: string }> {
  const found = await findEnterpriseScimMember(payload, args)
  if (!found.ok) return found
  if (!found.user || !found.member) return found
  const member = await payload.update({
    collection: 'organization-members' as any,
    id: found.member.id,
    data: { status: 'suspended' },
    depth: 0,
    overrideAccess: true,
  })
  return { ok: true, user: found.user, member }
}


function relationId(value: any): string | undefined {
  if (!value) return undefined
  return typeof value === 'object' ? String(value.id || '') || undefined : String(value)
}

export async function canReadEnterpriseRegistry(
  payload: Payload,
  args: { userId: string; userRole?: string; registryId: string },
): Promise<{ ok: true; registry: any; organizationId: string; role: string } | { ok: false; reason: string }> {
  const registry = await payload
    .findByID({ collection: 'enterprise-registries' as any, id: args.registryId, depth: 1, overrideAccess: true })
    .catch(() => null) as any
  if (!registry) return { ok: false, reason: '企业注册记录不存在' }
  const organizationId = relationId(registry.organization)
  if (!organizationId) return { ok: false, reason: '注册记录缺少组织上下文' }
  const org = await payload
    .findByID({ collection: 'organizations' as any, id: organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org || org.status === 'suspended') return { ok: false, reason: '组织不存在或已暂停' }
  if (args.userRole === 'admin') return { ok: true, registry, organizationId, role: 'platform_admin' }
  const ownerId = relationId(org.owner)
  if (ownerId && String(ownerId) === String(args.userId)) return { ok: true, registry, organizationId, role: 'owner' }

  const members = await payload.find({
    collection: 'organization-members' as any,
    where: {
      and: [
        { organization: { equals: organizationId } },
        { user: { equals: args.userId } },
        { status: { equals: 'active' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const member = members.docs[0] as any
  if (!member) return { ok: false, reason: '你不是该组织成员' }
  const memberRole = String(member.role || 'member')
  if (registry.approvalStatus === 'approved' || ['admin', 'auditor', 'approver'].includes(memberRole)) {
    return { ok: true, registry, organizationId, role: memberRole }
  }
  return { ok: false, reason: '该企业 Skill 尚未批准，普通成员不可查看' }
}

export async function getEnterpriseRegistryPassport(
  payload: Payload,
  args: { userId: string; userRole?: string; registryId: string },
): Promise<{ ok: true; registry: any; passport: any | null; organizationId: string } | { ok: false; reason: string }> {
  const access = await canReadEnterpriseRegistry(payload, args)
  if (!access.ok) return access
  const registry = access.registry
  const passportId = relationId(registry.passport)
  const skillId = relationId(registry.skill)
  let passport: any | null = null
  if (passportId) {
    passport = await payload
      .findByID({ collection: 'skill-passports' as any, id: passportId, depth: 0, overrideAccess: true })
      .catch(() => null)
    const passportSkillId = relationId(passport?.skill)
    if (passport && skillId && passportSkillId !== skillId) passport = null
    // 普通成员只能看到 current Passport，避免把草稿/过期/撤销证据当成企业内正式结论。
    if (passport && access.role === 'member' && passport.status !== 'current') passport = null
  }
  if (!passport && skillId) {
    const res = await payload.find({
      collection: 'skill-passports' as any,
      where: { and: [{ skill: { equals: skillId } }, { status: { equals: 'current' } }] },
      limit: 1,
      depth: 0,
      sort: '-lastVerifiedAt',
      overrideAccess: true,
    })
    passport = (res.docs as any[])[0] || null
  }
  return { ok: true, registry, passport, organizationId: access.organizationId }
}


function enterpriseAuditFailureType(row: any): string {
  if (row?.outcome === 'denied') return 'policy_denied'
  return String(row?.errorCode || 'unknown_infra')
}

export function enterpriseAuditRowsToFailureReports(rows: any[]): FailureKnowledgeReport[] {
  return rows
    .filter((row) => row?.outcome === 'failed' || row?.outcome === 'denied')
    .map((row) => ({
      errorType: enterpriseAuditFailureType(row),
      modelName: row.modelName || 'unknown',
      modelVersion: row.modelVersion || undefined,
      skill: row.skill,
      inputSizeBucket: row.inputSizeBucket || undefined,
      outputSizeBucket: row.outputSizeBucket || undefined,
      source: row.outcome === 'denied' ? 'enterprise_policy' : 'enterprise_run',
    }))
}

export function enterpriseFailureKnowledgeFromAuditRows(rows: any[], limit = 50): FailureKnowledgeGroup[] {
  return aggregateFailureKnowledge(enterpriseAuditRowsToFailureReports(rows), limit)
}

export async function getEnterpriseFailureKnowledge(
  payload: Payload,
  args: { organizationId: string; limit?: number },
): Promise<FailureKnowledgeGroup[]> {
  const res = await payload.find({
    collection: 'enterprise-audit-logs' as any,
    where: {
      and: [
        { organization: { equals: args.organizationId } },
        { or: [{ outcome: { equals: 'failed' } }, { outcome: { equals: 'denied' } }] },
      ],
    },
    limit: Math.min(Math.max(args.limit || 1000, 1), 5000),
    depth: 1,
    sort: '-createdAt',
    overrideAccess: true,
  })
  return enterpriseFailureKnowledgeFromAuditRows(res.docs as any[], 100)
}

export async function recordEnterpriseRunAudit(
  payload: Payload,
  args: {
    organizationId?: string
    registryId?: string
    actorId?: string
    skillId?: string
    skillVersionId?: string
    skillRunId?: string
    runId: string
    modelName?: string
    modelVersion?: string
    modelProfile?: string
    success?: boolean
    deniedReason?: string
    errorCode?: string
    input?: Record<string, unknown>
    outputText?: string
    latencyMs?: number
    estimatedCost?: number
    chargedCredits?: number
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  if (!args.organizationId || !args.skillId) return
  await payload.create({
    collection: 'enterprise-audit-logs' as any,
    overrideAccess: true,
    data: {
      organization: args.organizationId,
      registry: args.registryId,
      actor: args.actorId,
      skill: args.skillId,
      skillVersion: args.skillVersionId,
      skillRun: args.skillRunId,
      runId: args.runId,
      modelName: args.modelName,
      modelVersion: args.modelVersion,
      modelProfile: args.modelProfile,
      outcome: args.deniedReason ? 'denied' : args.success ? 'success' : 'failed',
      errorCode: args.errorCode,
      policyReason: args.deniedReason,
      inputSizeBucket: args.input ? bucketSize(JSON.stringify(args.input).length) : undefined,
      outputSizeBucket: args.outputText ? bucketSize(args.outputText.length) : undefined,
      latencyMs: args.latencyMs,
      estimatedCost: args.estimatedCost,
      chargedCredits: args.chargedCredits,
      metadata: sanitizeAuditMetadata(args.metadata),
    },
  })
}
