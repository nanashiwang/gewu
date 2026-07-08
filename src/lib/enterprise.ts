import { generatePayloadCookie, getFieldsToSign, jwtSign, type Payload } from 'payload'
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'crypto'
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
    jwks?: { keys?: any[] }
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
      jwks: ssoRaw.jwks && typeof ssoRaw.jwks === 'object' && !Array.isArray(ssoRaw.jwks) ? ssoRaw.jwks : undefined,
    },
    scim: {
      enabled: scimRaw.enabled === true || input.scimEnabled === true || input.scim_enabled === true,
      baseUrl: typeof scimRaw.baseUrl === 'string' ? scimRaw.baseUrl.trim() : typeof scimRaw.base_url === 'string' ? scimRaw.base_url.trim() : undefined,
      tokenDigest: typeof scimRaw.tokenDigest === 'string' ? scimRaw.tokenDigest.trim() : typeof scimRaw.token_digest === 'string' ? scimRaw.token_digest.trim() : undefined,
    },
  }
  if (!policy.sso?.enabled && !policy.sso?.provider && !policy.sso?.issuer && !policy.sso?.clientId && !policy.sso?.discoveryUrl && !policy.sso?.authorizationEndpoint && !policy.sso?.tokenEndpoint && !policy.sso?.jwksUri && !policy.sso?.jwks) delete policy.sso
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
  if (policy.sso) safe.sso = { ...policy.sso, ...(policy.sso.jwks ? { jwks: { keys: 'configured' as any } } : {}) }
  if (policy.scim) {
    const { tokenDigest: _tokenDigest, ...scim } = policy.scim
    safe.scim = {
      ...scim,
      ...(policy.scim.tokenDigest ? { tokenDigest: 'configured' } : {}),
    }
  }
  return safe
}

export function enterpriseIdentityPlaybook(rawPolicy: unknown) {
  const policy = normalizeEnterpriseIdentityPolicy(rawPolicy)
  const issues = validateEnterpriseIdentityPolicy(policy)
  const blockers = issues.filter((issue) => issue.level === 'blocker')
  const warnings = issues.filter((issue) => issue.level === 'warning')
  const ssoEnabled = policy?.sso?.enabled === true
  const scimEnabled = policy?.scim?.enabled === true
  const decision = blockers.length
    ? 'fix_config'
    : policy?.requireSso && ssoEnabled && scimEnabled
      ? 'enforce'
      : ssoEnabled && !scimEnabled
        ? 'provision_scim'
        : 'configure'

  return {
    customerValue:
      '把企业身份治理从“手工加人”变成可审计准入：先限制邮箱域，再接 SSO，最后用 SCIM 自动同步成员并保留最小权限边界。',
    decision,
    issues: issues.map((issue) => ({ level: issue.level, code: issue.code, message: issue.message })),
    readiness: {
      domainAllowlistConfigured: Boolean(policy?.domainAllowlist?.length),
      requireSso: policy?.requireSso === true,
      ssoEnabled,
      scimEnabled,
      blockers: blockers.length,
      warnings: warnings.length,
    },
    checklist: [
      '域名白名单只写企业实际邮箱域，避免个人邮箱进入组织',
      'SSO URL 必须为 HTTPS，OIDC 至少配置 provider、issuer 和 clientId',
      'SCIM 只保存 sha256 tokenDigest，不保存明文 token',
      '启用 requireSso 前，先确认管理员可通过 SSO/SCIM 保留组织访问权',
    ],
    nextActions: [
      {
        label: blockers.length ? '修复阻断项' : '保存身份策略',
        description: blockers.length
          ? '当前配置存在 blocker，保存或启用前必须先修复。'
          : '当前身份策略已通过格式校验，可在企业控制台保存并纳入成员准入。',
        href: '/console/enterprise',
      },
      {
        label: '测试 SSO 准入',
        description: ssoEnabled
          ? '用白名单域账号测试 SSO 登录；requireSso 启用后，password 登录会被组织策略拒绝。'
          : '尚未启用 SSO；可先配置 OIDC/SAML provider、issuer、clientId 和 discovery URL。',
        href: '/console/enterprise',
      },
      {
        label: '测试 SCIM 同步',
        description: scimEnabled
          ? '用 Bearer token 调用 SCIM users 端点创建/停用成员，确认只返回标准 User/ListResponse。'
          : '尚未启用 SCIM；配置 baseUrl 和 sha256 tokenDigest 后再接 IdP provision。',
        href: '/v1/enterprise/scim/users',
      },
      {
        label: '复核成员边界',
        description: '添加 active 成员时会执行邮箱域和 SSO 策略；不符合策略的成员不得进入组织。',
        href: '/v1/enterprise/members',
      },
    ],
  }
}

export type EnterpriseSsoStatePayload = {
  organizationId: string
  redirectPath: string
  nonce: string
  issuedAt: number
  expiresAt: number
}

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url')
}

function hmacState(payload: string, secret = process.env.PAYLOAD_SECRET || 'dev-secret') {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signEnterpriseSsoState(payload: EnterpriseSsoStatePayload, secret?: string) {
  const body = b64url(JSON.stringify(payload))
  return `${body}.${hmacState(body, secret)}`
}

export function verifyEnterpriseSsoState(
  state: string,
  options: { secret?: string; now?: number } = {},
): { ok: true; payload: EnterpriseSsoStatePayload } | { ok: false; reason: string } {
  const [body, sig] = String(state || '').split('.')
  if (!body || !sig) return { ok: false, reason: 'SSO state 格式无效' }
  const expected = hmacState(body, options.secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'SSO state 签名无效' }
  let payload: EnterpriseSsoStatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'SSO state 载荷无效' }
  }
  const now = options.now ?? Date.now()
  if (!payload.organizationId || !payload.nonce || !payload.redirectPath) return { ok: false, reason: 'SSO state 缺少组织上下文' }
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < now) return { ok: false, reason: 'SSO state 已过期' }
  return { ok: true, payload }
}

export function buildEnterpriseSsoAuthorizeUrl(
  rawPolicy: unknown,
  args: { organizationId: string; baseUrl: string; redirectPath?: string; state?: string; nonce?: string },
): { ok: true; authorize: any } | { ok: false; reason: string; issues?: EnterpriseIdentityPolicyIssue[] } {
  const policy = normalizeEnterpriseIdentityPolicy(rawPolicy)
  const issues = validateEnterpriseIdentityPolicy(policy)
  const blockers = issues.filter((issue) => issue.level === 'blocker')
  if (blockers.length) return { ok: false, reason: '身份策略存在阻断项，不能发起 SSO', issues }
  const sso = policy?.sso
  if (!sso?.enabled) return { ok: false, reason: '组织未启用 SSO' }
  const provider = String(sso.provider || '').toLowerCase()
  if (!['oidc', 'okta', 'azuread', 'google'].includes(provider)) {
    return { ok: false, reason: '当前只支持 OIDC 类 SSO 发起包；SAML/自定义 provider 后续接入', issues }
  }
  if (!sso.clientId) return { ok: false, reason: 'SSO 缺少 clientId', issues }
  const authorizationEndpoint = sso.authorizationEndpoint || (sso.issuer ? `${sso.issuer.replace(/\/$/, '')}/authorize` : '')
  if (!authorizationEndpoint || !isHttpsUrl(authorizationEndpoint)) {
    return { ok: false, reason: 'SSO 缺少 HTTPS authorizationEndpoint', issues }
  }
  const origin = (() => {
    try {
      const url = new URL(args.baseUrl)
      return url.origin
    } catch {
      return ''
    }
  })()
  if (!origin) return { ok: false, reason: '站点地址无效，不能生成 callbackUrl', issues }
  const callbackUrl = `${origin}/v1/enterprise/identity/callback`
  const redirectPath = String(args.redirectPath || '/console/enterprise').startsWith('/')
    ? String(args.redirectPath || '/console/enterprise').slice(0, 300)
    : '/console/enterprise'
  const nonce = args.nonce || randomBytes(18).toString('base64url')
  const issuedAt = Date.now()
  const state = args.state || signEnterpriseSsoState({
    organizationId: args.organizationId,
    redirectPath,
    nonce,
    issuedAt,
    expiresAt: issuedAt + 10 * 60 * 1000,
  })
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', sso.clientId)
  url.searchParams.set('redirect_uri', callbackUrl)
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)

  return {
    ok: true,
    authorize: publicSanitize({
      provider: sso.provider || provider,
      organizationId: args.organizationId,
      authorizeUrl: url.toString(),
      callbackUrl,
      state,
      nonce,
      redirectPath,
      customerValue:
        '这是企业 SSO 登录连接器的发起包：前端跳转到 IdP，回调后再完成 code 换 token、邮箱域校验和组织成员绑定。',
      nextActions: [
        {
          label: '跳转 IdP',
          description: '使用 authorizeUrl 发起 OIDC 登录，scope 固定为 openid email profile。',
          href: url.toString(),
        },
        {
          label: '配置回调地址',
          description: '在 IdP 后台把 callbackUrl 加入允许回调列表；生产必须使用 HTTPS 站点地址。',
          href: callbackUrl,
        },
        {
          label: '回调后校验组织身份',
          description: 'callback 会先校验 HMAC state 并还原组织上下文；后续再补 code 换 token、邮箱域白名单和组织成员关系。',
          href: '/v1/enterprise/identity/callback',
        },
      ],
    }),
  }
}

export function buildEnterpriseOidcTokenRequest(
  rawPolicy: unknown,
  args: { code: string; callbackUrl: string },
): { ok: true; tokenRequest: any } | { ok: false; reason: string; issues?: EnterpriseIdentityPolicyIssue[] } {
  const policy = normalizeEnterpriseIdentityPolicy(rawPolicy)
  const issues = validateEnterpriseIdentityPolicy(policy)
  const blockers = issues.filter((issue) => issue.level === 'blocker')
  if (blockers.length) return { ok: false, reason: '身份策略存在阻断项，不能换取 OIDC token', issues }
  const sso = policy?.sso
  if (!sso?.enabled) return { ok: false, reason: '组织未启用 SSO' }
  const provider = String(sso.provider || '').toLowerCase()
  if (!['oidc', 'okta', 'azuread', 'google'].includes(provider)) return { ok: false, reason: '当前只支持 OIDC 类 token exchange', issues }
  if (!sso.clientId) return { ok: false, reason: 'SSO 缺少 clientId', issues }
  const tokenEndpoint = sso.tokenEndpoint || (sso.issuer ? `${sso.issuer.replace(/\/$/, '')}/token` : '')
  if (!tokenEndpoint || !isHttpsUrl(tokenEndpoint)) return { ok: false, reason: 'SSO 缺少 HTTPS tokenEndpoint', issues }
  if (!isHttpsUrl(args.callbackUrl)) return { ok: false, reason: 'callbackUrl 必须是 HTTPS URL', issues }

  return {
    ok: true,
    tokenRequest: publicSanitize({
      method: 'POST',
      tokenEndpoint,
      contentType: 'application/x-www-form-urlencoded',
      body: {
        grant_type: 'authorization_code',
        code: args.code ? '<callback_code>' : '',
        redirect_uri: args.callbackUrl,
        client_id: sso.clientId,
      },
      secretHandling:
        '如 IdP 要求 client_secret，应在服务端密钥仓库补充并只在后端 token exchange 使用，不进入公开响应或浏览器。',
      nextActions: [
        {
          label: '服务端换取 token',
          description: '用该请求包在后端调用 tokenEndpoint；不得把 client_secret 下发到浏览器。',
        },
        {
          label: '校验 ID Token',
          description: '下一步校验 issuer、audience、exp、nonce，再读取 email / email_verified。',
        },
        {
          label: '绑定组织成员',
          description: '通过邮箱域白名单和组织成员关系后，才创建登录会话。',
        },
      ],
    }),
  }
}


function base64UrlJson(segment: string): any | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function decodeJwtClaims(token: string): { header: any; claims: any } | null {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const header = base64UrlJson(parts[0])
  const claims = base64UrlJson(parts[1])
  if (!header || !claims || typeof claims !== 'object') return null
  return { header, claims }
}

function verifyJwtWithConfiguredJwks(token: string, header: any, sso: EnterpriseIdentityPolicy['sso']): { configured: boolean; valid: boolean; reason?: string } {
  const keys = Array.isArray(sso?.jwks?.keys) ? sso?.jwks?.keys || [] : []
  if (!keys.length) return { configured: false, valid: false }
  if (String(header?.alg || '') !== 'RS256') return { configured: true, valid: false, reason: '仅支持 RS256 JWKS 签名校验' }
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return { configured: true, valid: false, reason: 'JWT 格式无效' }
  const kid = header?.kid ? String(header.kid) : ''
  const jwk = keys.find((key: any) => key?.kty === 'RSA' && (!kid || String(key?.kid || '') === kid))
  if (!jwk) return { configured: true, valid: false, reason: kid ? `JWKS 未找到 kid=${kid}` : 'JWKS 未找到 RSA 公钥' }
  try {
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${parts[0]}.${parts[1]}`)
    verifier.end()
    const key = createPublicKey({ key: jwk, format: 'jwk' } as any)
    return { configured: true, valid: verifier.verify(key, Buffer.from(parts[2], 'base64url')) }
  } catch (e) {
    return { configured: true, valid: false, reason: (e as Error).message }
  }
}

export function verifyEnterpriseOidcIdTokenClaims(
  rawPolicy: unknown,
  args: { idToken: string; nonce?: string; nowSeconds?: number },
): { ok: true; claims: any; email: string; header: any; warnings: string[] } | { ok: false; reason: string; code: string; claims?: any; warnings?: string[] } {
  const policy = normalizeEnterpriseIdentityPolicy(rawPolicy)
  const sso = policy?.sso
  if (!sso?.enabled) return { ok: false, code: 'SSO_DISABLED', reason: '组织未启用 SSO' }
  if (!sso.issuer || !sso.clientId) return { ok: false, code: 'OIDC_CONFIG_INCOMPLETE', reason: 'OIDC issuer/clientId 未配置' }
  const decoded = decodeJwtClaims(args.idToken)
  if (!decoded) return { ok: false, code: 'ID_TOKEN_INVALID_FORMAT', reason: 'ID Token 不是合法 JWT' }
  const { header, claims } = decoded
  const signature = verifyJwtWithConfiguredJwks(args.idToken, header, sso)
  if (signature.configured && !signature.valid) return { ok: false, code: 'ID_TOKEN_SIGNATURE_INVALID', reason: signature.reason || 'ID Token 签名校验失败', claims, warnings: [] }
  const warnings = signature.configured ? [] : ['未配置 JWKS 公钥；当前仅校验 issuer/audience/exp/nonce/email 与组织成员边界']
  const issuer = String(claims.iss || '')
  if (issuer !== sso.issuer.replace(/\/$/, '')) return { ok: false, code: 'ISSUER_MISMATCH', reason: 'ID Token issuer 与组织配置不一致', claims, warnings }
  const audience = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')]
  if (!audience.includes(String(sso.clientId))) return { ok: false, code: 'AUDIENCE_MISMATCH', reason: 'ID Token audience 不包含 clientId', claims, warnings }
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  const exp = Number(claims.exp || 0)
  if (!Number.isFinite(exp) || exp <= now) return { ok: false, code: 'ID_TOKEN_EXPIRED', reason: 'ID Token 已过期', claims, warnings }
  if (args.nonce && String(claims.nonce || '') !== String(args.nonce)) return { ok: false, code: 'NONCE_MISMATCH', reason: 'ID Token nonce 与 state 不一致', claims, warnings }
  const email = String(claims.email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, code: 'EMAIL_MISSING', reason: 'ID Token 缺少 email', claims, warnings }
  if (claims.email_verified === false || claims.email_verified === 'false') return { ok: false, code: 'EMAIL_NOT_VERIFIED', reason: 'ID Token email 未验证', claims, warnings }
  const policyCheck = evaluateEnterpriseIdentityPolicy(policy, { email, authMethod: 'sso' })
  if (!policyCheck.ok) return { ok: false, code: 'DOMAIN_REJECTED', reason: policyCheck.reason, claims, warnings }
  return { ok: true, claims, email, header, warnings }
}


export async function issueEnterpriseSsoSession(
  payload: Payload,
  args: { user: any; email?: string },
): Promise<{ token: string; exp: number; cookie: string; user: any }> {
  const collectionConfig = (payload as any).collections?.users?.config
  if (!collectionConfig?.auth) throw new Error('users auth collection is not configured')
  const email = String(args.email || args.user?.email || '').trim().toLowerCase()
  if (!email) throw new Error('SSO user email missing')
  if (args.user?.accountStatus === 'banned') throw new Error('账号已被封禁')
  const fieldsToSign = getFieldsToSign({
    collectionConfig,
    email,
    user: args.user,
  })
  const { exp, token } = await jwtSign({
    fieldsToSign,
    secret: String((payload as any).secret || (payload as any).config?.secret || process.env.PAYLOAD_SECRET || 'dev-secret'),
    tokenExpiration: Number(collectionConfig.auth.tokenExpiration || 7200),
  })
  const cookie = generatePayloadCookie({
    collectionAuthConfig: collectionConfig.auth,
    cookiePrefix: String((payload as any).config?.cookiePrefix || 'payload'),
    token,
  })
  return {
    token,
    exp,
    cookie,
    user: {
      id: String(args.user.id || ''),
      email,
      username: args.user.username || null,
      role: args.user.role || 'user',
    },
  }
}

export async function resolveEnterpriseSsoMemberBinding(
  payload: Payload,
  args: { organizationId: string; email: string },
): Promise<{ ok: true; user: any; member: any; binding: any } | { ok: false; reason: string; code: string; binding?: any }> {
  const email = String(args.email || '').trim().toLowerCase()
  const users = await payload.find({
    collection: 'users' as any,
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const user = users.docs[0] as any
  if (!user || user.accountStatus === 'banned') return { ok: false, code: 'USER_NOT_FOUND', reason: 'SSO 邮箱尚未绑定有效平台用户', binding: { email } }
  const members = await payload.find({
    collection: 'organization-members' as any,
    where: {
      and: [
        { organization: { equals: args.organizationId } },
        { user: { equals: user.id } },
        { status: { equals: 'active' } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const member = members.docs[0] as any
  if (!member) return { ok: false, code: 'MEMBER_NOT_ACTIVE', reason: '该 SSO 用户尚未绑定为组织 active 成员', binding: { email, userId: String(user.id) } }
  return {
    ok: true,
    user,
    member,
    binding: {
      email,
      userId: String(user.id),
      organizationId: args.organizationId,
      memberId: String(member.id),
      role: member.role || 'member',
      status: member.status || 'active',
    },
  }
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
    identityPlaybook: publicSanitize(enterpriseIdentityPlaybook(org.identityPolicy)),
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
  const registryId = registry?.id ? String(registry.id) : ''
  const organizationId = relationId(registry?.organization)
  const skill = registry?.skill && typeof registry.skill === 'object' ? registry.skill : null
  const skillSlug = skill?.slug ? String(skill.slug) : ''
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
    governanceChecklist: [
      '准入前复核组织内 Passport、达标证书、Contract 和证据验签状态',
      '批准时绑定模型白名单、输入规模、BYOK、路由模式和审计策略',
      '运行时必须携带 organizationId，保证授权、策略和审计都进入企业上下文',
      '上线后定期导出审计并查看企业失败库，决定是否撤销、锁版本或补 Adapter',
    ],
    nextActions: [
      {
        label: '复核证据',
        description:
          '先看组织内 Passport、达标证书和证据验签摘要；证书未 passed 时需要风险确认或继续人工复核。',
        href: registryId ? `/v1/enterprise/registry/${encodeURIComponent(registryId)}/passport` : null,
      },
      {
        label: '绑定模型白名单',
        description: modelCount > 0
          ? `已限制 ${modelCount} 个模型，运行时会按组织准入边界检查。`
          : '尚未限制模型，建议按已验证模型版本设置白名单。',
        href: '/console/enterprise',
      },
      {
        label: '执行运行授权',
        description:
          decision === 'allow'
            ? '已批准 Registry 可进入企业运行授权；仍会执行审计策略、输入规模和 BYOK 等边界。'
            : '未批准前不应让普通成员使用该 Skill。',
        href: skillSlug && organizationId
          ? `/skills/${encodeURIComponent(skillSlug)}/run?organizationId=${encodeURIComponent(organizationId)}`
          : null,
      },
      {
        label: '留审计并查失败库',
        description:
          '企业运行、策略拒绝和失败会进入审计；后续可聚合组织内失败知识库，不暴露员工输入输出原文。',
        href: organizationId
          ? `/v1/enterprise/failures?organizationId=${encodeURIComponent(organizationId)}`
          : null,
      },
      {
        label: '导出审计',
        description: '导出组织运行审计 CSV，复核模型版本、策略拒绝和失败分布，不包含输入输出原文。',
        href: organizationId
          ? `/v1/enterprise/audit/export?organizationId=${encodeURIComponent(organizationId)}`
          : null,
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
    adoptionBaseline: publicSanitize(registry.adoptionBaseline || null),
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


export async function buildEnterpriseAdoptionBaseline(
  payload: Payload,
  args: { skill: any; skillId: string; skillVersionId?: string; passportId?: string; certificateSummary?: any },
) {
  const version = args.skillVersionId
    ? await payload.findByID({ collection: 'skill-versions' as any, id: args.skillVersionId, depth: 0, overrideAccess: true }).catch(() => null)
    : await resolveCurrentSkillVersionForPublicEvidence(payload, args.skill).catch(() => null)
  const passport = args.passportId
    ? await payload.findByID({ collection: 'skill-passports' as any, id: args.passportId, depth: 0, overrideAccess: true }).catch(() => null)
    : (
        await payload.find({
          collection: 'skill-passports' as any,
          where: { and: [{ skill: { equals: args.skillId } }, { status: { equals: 'current' } }] },
          sort: '-lastVerifiedAt',
          limit: 1,
          depth: 0,
          overrideAccess: true,
        }).catch(() => ({ docs: [] as any[] }))
      ).docs[0]

  const contractSummary = version
    ? publicSkillContract(version, { slug: args.skill?.slug })
    : null
  return publicSanitize({
    capturedAt: new Date().toISOString(),
    skill: {
      id: String(args.skillId),
      slug: args.skill?.slug || null,
      title: args.skill?.title || args.skill?.name || null,
    },
    contract: contractSummary
      ? {
          versionId: String((version as any).id || ''),
          version: (version as any).version || null,
          contractHash: contractSummary.contractHash || null,
          systemPromptHash: contractSummary.systemPromptHash || null,
          promptTemplateHash: contractSummary.promptTemplateHash || null,
          minimumRunnerVersion: contractSummary.minRunnerVersion || null,
          permissions: contractSummary.permissions || [],
          recommendedModels: contractSummary.recommendedModels || [],
        }
      : null,
    passport: passport
      ? {
          id: String((passport as any).id || ''),
          status: (passport as any).status || null,
          skillClass: (passport as any).skillClass || null,
          trustScore: (passport as any).trustScore ?? null,
          evidenceHash: (passport as any).evidenceHash || null,
          lastVerifiedAt: (passport as any).lastVerifiedAt || null,
          trustedCompatibleRunCount: (passport as any).trustedCompatibleRunCount ?? null,
        }
      : null,
    certificate: args.certificateSummary
      ? {
          status: args.certificateSummary.status || null,
          statusReasons: args.certificateSummary.statusReasons || [],
          certificateHash: args.certificateSummary.certificateHash || null,
          signed: Boolean(args.certificateSummary.signed),
        }
      : null,
    governance: {
      value: '企业批准时冻结采用基线；后续 Skill/Contract/Passport 变化时，用该快照判断是否需要重新审批。',
      reapproveWhen: ['contractHash_changed', 'passport_stale_or_failed', 'certificate_status_worse', 'model_allowlist_changed'],
    },
  })
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
    data.adoptionBaseline = await buildEnterpriseAdoptionBaseline(payload, {
      skill,
      skillId: args.skillId,
      skillVersionId: args.skillVersionId,
      passportId: args.passportId,
      certificateSummary,
    })
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


export function evaluateEnterpriseAdoptionBaselineDrift(
  registry: any,
  current: { version?: any; passport?: any; certificateSummary?: any } = {},
) {
  const baseline = registry?.adoptionBaseline && typeof registry.adoptionBaseline === 'object' ? registry.adoptionBaseline : null
  if (!baseline) {
    return {
      status: 'missing_baseline',
      reapprovalRequired: false,
      reasons: ['adoption_baseline_missing'],
      customerValue: '该 Registry 尚无批准时采用基线；建议重新保存一次准入记录，冻结 Contract/Passport/证书摘要。',
    }
  }
  const currentContract = current.version ? publicSkillContract(current.version, { slug: registry?.skill?.slug }) : null
  const reasons: string[] = []
  if (baseline.contract?.versionId && !current.version?.id) {
    reasons.push('version_missing')
  }
  if (baseline.contract?.contractHash && !currentContract?.contractHash) {
    reasons.push('contract_missing')
  }
  if (baseline.contract?.contractHash && currentContract?.contractHash && baseline.contract.contractHash !== currentContract.contractHash) {
    reasons.push('contractHash_changed')
  }
  if (baseline.contract?.versionId && current.version?.id && String(baseline.contract.versionId) !== String(current.version.id)) {
    reasons.push('version_changed')
  }
  if (baseline.passport?.id && current.passport?.id && String(baseline.passport.id) !== String(current.passport.id)) {
    reasons.push('passport_changed')
  }
  if (baseline.passport?.evidenceHash && current.passport?.evidenceHash && baseline.passport.evidenceHash !== current.passport.evidenceHash) {
    reasons.push('passport_evidence_changed')
  }
  const currentPassportStatus = current.passport?.status ? String(current.passport.status) : ''
  if (currentPassportStatus && currentPassportStatus !== 'current') reasons.push('passport_not_current')
  const baselineCertStatus = baseline.certificate?.status ? String(baseline.certificate.status) : ''
  const currentCertStatus = current.certificateSummary?.status ? String(current.certificateSummary.status) : ''
  if (baselineCertStatus === 'passed' && currentCertStatus && currentCertStatus !== 'passed') reasons.push('certificate_status_worse')
  if (baseline.certificate?.certificateHash && current.certificateSummary?.certificateHash && baseline.certificate.certificateHash !== current.certificateSummary.certificateHash) {
    reasons.push('certificate_hash_changed')
  }
  const reapprovalRequired = reasons.some((r) => ['contract_missing', 'contractHash_changed', 'version_missing', 'version_changed', 'certificate_status_worse'].includes(r))
  return {
    status: reasons.length ? (reapprovalRequired ? 'reapproval_required' : 'review_recommended') : 'unchanged',
    reapprovalRequired,
    reasons,
    baselineCapturedAt: baseline.capturedAt || null,
    current: publicSanitize({
      contractHash: currentContract?.contractHash || null,
      versionId: current.version?.id ? String(current.version.id) : null,
      passportId: current.passport?.id ? String(current.passport.id) : null,
      passportStatus: currentPassportStatus || null,
      passportEvidenceHash: current.passport?.evidenceHash || null,
      certificateStatus: currentCertStatus || null,
      certificateHash: current.certificateSummary?.certificateHash || null,
    }),
    nextActions: [
      {
        label: reapprovalRequired ? '重新审批 Skill' : '复核证据变化',
        description: reapprovalRequired
          ? '当前 Contract/版本/证书状态相对批准基线发生强变化，应重新走企业准入审批。'
          : reasons.length
            ? '当前 Passport 或证据 hash 有变化，建议审核员复核后决定是否更新基线。'
            : '当前证据与批准基线一致，可继续按原治理策略使用。',
        href: registry?.id ? `/v1/enterprise/registry/${encodeURIComponent(String(registry.id))}/passport` : null,
      },
    ],
  }
}


export type EnterpriseRegistryReapprovalStatus = 'missing_baseline' | 'reapproval_required' | 'review_recommended' | 'unchanged'
export type EnterpriseRegistryReapprovalAction = 'refresh_baseline' | 'accept_risk' | 'mark_reviewed'

const ENTERPRISE_REAPPROVAL_STATUSES = new Set<EnterpriseRegistryReapprovalStatus>([
  'missing_baseline',
  'reapproval_required',
  'review_recommended',
  'unchanged',
])

function normalizeRegistryReapprovalStatus(value?: unknown): EnterpriseRegistryReapprovalStatus | 'all' | undefined {
  const status = String(value || '').trim()
  if (!status) return undefined
  if (status === 'all') return 'all'
  return ENTERPRISE_REAPPROVAL_STATUSES.has(status as EnterpriseRegistryReapprovalStatus)
    ? status as EnterpriseRegistryReapprovalStatus
    : undefined
}

function appendReviewNote(existing: unknown, note?: string, prefix = '批量重审') {
  const clean = typeof note === 'string' ? note.trim().slice(0, 1000) : ''
  if (!clean) return existing
  const current = typeof existing === 'string' ? existing.trim() : ''
  const line = `[${new Date().toISOString()}] ${prefix}：${clean}`
  return current ? `${current}\n${line}` : line
}

async function resolveEnterpriseRegistryReviewContext(payload: Payload, registry: any) {
  const skillId = relationId(registry?.skill)
  const skill = registry?.skill && typeof registry.skill === 'object' && registry.skill.id
    ? registry.skill
    : skillId
      ? await payload.findByID({ collection: 'skills' as any, id: skillId, depth: 0, overrideAccess: true }).catch(() => null)
      : null
  const skillVersionId = relationId(registry?.skillVersion)
  const version = skillVersionId
    ? await payload.findByID({ collection: 'skill-versions' as any, id: skillVersionId, depth: 0, overrideAccess: true }).catch(() => null)
    : skill
      ? await resolveCurrentSkillVersionForPublicEvidence(payload, skill).catch(() => null)
      : null
  const passportId = relationId(registry?.passport)
  let passport = passportId
    ? await payload.findByID({ collection: 'skill-passports' as any, id: passportId, depth: 0, overrideAccess: true }).catch(() => null)
    : null
  const passportSkillId = relationId((passport as any)?.skill)
  if (passport && skillId && passportSkillId && passportSkillId !== skillId) passport = null
  if (!passport && skillId) {
    passport = (
      await payload.find({
        collection: 'skill-passports' as any,
        where: { and: [{ skill: { equals: skillId } }, { status: { equals: 'current' } }] },
        sort: '-lastVerifiedAt',
        limit: 1,
        depth: 0,
        overrideAccess: true,
      }).catch(() => ({ docs: [] as any[] }))
    ).docs[0] || null
  }
  const certificateSummary = skill && skillId
    ? await getEnterpriseApprovalCertificateSummary(payload, {
        skill,
        skillId,
        skillVersionId,
        passportId: passportId || undefined,
      }).catch((e) => ({
        status: 'provisional',
        statusReasons: ['certificate_check_failed'],
        signed: false,
        error: (e as Error).message,
      }))
    : { status: 'failed', statusReasons: ['skill_missing'], signed: false }

  return { skill, skillId, skillVersionId, version, passport, passportId, certificateSummary }
}

async function enterpriseRegistryReapprovalItem(payload: Payload, registry: any) {
  const context = await resolveEnterpriseRegistryReviewContext(payload, registry)
  const drift = evaluateEnterpriseAdoptionBaselineDrift(registry, {
    version: context.version,
    passport: context.passport,
    certificateSummary: context.certificateSummary,
  })
  const status = drift.status as EnterpriseRegistryReapprovalStatus
  const decision = status === 'reapproval_required'
    ? 'reapprove'
    : status === 'review_recommended'
      ? 'review'
      : status === 'missing_baseline'
        ? 'refresh_baseline'
        : 'keep'

  return publicSanitize({
    registry: publicEnterpriseRegistry(registry),
    review: {
      status,
      decision,
      reapprovalRequired: drift.reapprovalRequired,
      reasons: drift.reasons || [],
      baselineCapturedAt: drift.baselineCapturedAt || null,
      current: drift.current || null,
      nextActions: [
        ...(drift.nextActions || []),
        {
          label: '批量处理',
          description: '审核员可批量刷新采用基线、标记已复核，或在保留风险说明后接受漂移。',
          href: '/v1/enterprise/registry/review-required',
        },
      ],
    },
    certificateSummary: context.certificateSummary,
  })
}

function enterpriseReapprovalSummary(items: any[], scanned: number) {
  const counts: Record<EnterpriseRegistryReapprovalStatus, number> = {
    missing_baseline: 0,
    reapproval_required: 0,
    review_recommended: 0,
    unchanged: 0,
  }
  for (const item of items) {
    const status = item?.review?.status as EnterpriseRegistryReapprovalStatus
    if (status && counts[status] !== undefined) counts[status] += 1
  }
  return {
    scanned,
    returned: items.length,
    actionable: counts.missing_baseline + counts.reapproval_required + counts.review_recommended,
    ...counts,
  }
}

export async function listEnterpriseRegistriesForReapproval(
  payload: Payload,
  args: {
    actorId: string
    actorRole?: string
    organizationId: string
    status?: EnterpriseRegistryReapprovalStatus | 'all' | string
    registryStatus?: string
    includeUnchanged?: boolean
    limit?: number
  },
): Promise<{ ok: true; organizationId: string; summary: any; items: any[]; customerValue: string; nextActions: any[] } | { ok: false; reason: string }> {
  const access = await canManageOrganization(payload, {
    userId: args.actorId,
    userRole: args.actorRole,
    organizationId: args.organizationId,
    roles: ['platform_admin', 'owner', 'admin', 'approver'],
  })
  if (!access.ok) return access
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 200)
  const res = await payload.find({
    collection: 'enterprise-registries' as any,
    where: { organization: { equals: args.organizationId } },
    sort: '-updatedAt',
    limit,
    depth: 1,
    overrideAccess: true,
  })
  const registryStatus = String(args.registryStatus || '').trim()
  const selectedReviewStatus = normalizeRegistryReapprovalStatus(args.status)
  const includeUnchanged = args.includeUnchanged === true || selectedReviewStatus === 'all'
  const defaultRegistryStatuses = new Set(['approved', 'restricted'])
  const registries = (res.docs as any[]).filter((registry) => {
    if (registryStatus && registryStatus !== 'all') return String(registry.approvalStatus || '') === registryStatus
    return defaultRegistryStatuses.has(String(registry.approvalStatus || ''))
  })
  const items: any[] = []
  for (const registry of registries) {
    const item = await enterpriseRegistryReapprovalItem(payload, registry)
    const status = item.review.status as EnterpriseRegistryReapprovalStatus
    if (selectedReviewStatus && selectedReviewStatus !== 'all' && status !== selectedReviewStatus) continue
    if (!includeUnchanged && status === 'unchanged') continue
    items.push(item)
  }

  return {
    ok: true,
    organizationId: args.organizationId,
    summary: enterpriseReapprovalSummary(items, registries.length),
    items,
    customerValue:
      '企业准入批量重审把 Contract、Passport、证书和批准时采用基线放到同一张待办表里；管理员不用逐个打开 Skill，也能发现哪些准入需要重新审批或刷新基线。',
    nextActions: [
      {
        label: '重新审批强漂移项',
        description: 'Contract、版本或证书状态变差时，按企业准入流程重新审批，再刷新采用基线。',
        href: '/v1/enterprise/registry/review-required?status=reapproval_required',
      },
      {
        label: '复核证据变化',
        description: 'Passport 或证据 hash 变化时，审核员可批量标记已复核或接受风险。',
        href: '/v1/enterprise/registry/review-required?status=review_recommended',
      },
      {
        label: '补齐采用基线',
        description: '历史 Registry 缺少 adoptionBaseline 时，批量刷新当前 Contract/Passport/证书摘要作为后续漂移判断基线。',
        href: '/v1/enterprise/registry/review-required?status=missing_baseline',
      },
    ],
  }
}

export async function bulkReviewEnterpriseRegistryReapproval(
  payload: Payload,
  args: {
    actorId: string
    actorRole?: string
    organizationId: string
    registryIds: string[]
    action: EnterpriseRegistryReapprovalAction | string
    note?: string
  },
): Promise<{ ok: true; organizationId: string; action: EnterpriseRegistryReapprovalAction; summary: any; results: any[] } | { ok: false; reason: string }> {
  const access = await canManageOrganization(payload, {
    userId: args.actorId,
    userRole: args.actorRole,
    organizationId: args.organizationId,
    roles: ['platform_admin', 'owner', 'admin', 'approver'],
  })
  if (!access.ok) return access
  const action = String(args.action || '') as EnterpriseRegistryReapprovalAction
  if (!['refresh_baseline', 'accept_risk', 'mark_reviewed'].includes(action)) return { ok: false, reason: '批量重审动作无效' }
  const registryIds = [...new Set((args.registryIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 100)
  if (!registryIds.length) return { ok: false, reason: '缺少 registryIds' }
  const reviewedAt = new Date().toISOString()
  const results: any[] = []

  for (const id of registryIds) {
    const registry = await payload
      .findByID({ collection: 'enterprise-registries' as any, id, depth: 1, overrideAccess: true })
      .catch(() => null) as any
    if (!registry) {
      results.push({ id, ok: false, error: '企业注册记录不存在' })
      continue
    }
    const organizationId = relationId(registry.organization)
    if (String(organizationId || '') !== String(args.organizationId)) {
      results.push({ id, ok: false, error: '注册记录不属于该组织' })
      continue
    }

    const before = await enterpriseRegistryReapprovalItem(payload, registry)
    const context = await resolveEnterpriseRegistryReviewContext(payload, registry)
    const auditPolicy = registry.auditPolicy && typeof registry.auditPolicy === 'object' && !Array.isArray(registry.auditPolicy)
      ? { ...registry.auditPolicy }
      : {}
    const reviewRecord = publicSanitize({
      action,
      reviewedAt,
      reviewedBy: args.actorId,
      status: before.review.status,
      reasons: before.review.reasons || [],
      note: typeof args.note === 'string' ? args.note.trim().slice(0, 1000) : undefined,
    })
    let data: Record<string, unknown>
    if (action === 'refresh_baseline') {
      if (!context.skill || !context.skillId) {
        results.push({ id, ok: false, error: 'Skill 不存在，不能刷新采用基线' })
        continue
      }
      data = {
        adoptionBaseline: await buildEnterpriseAdoptionBaseline(payload, {
          skill: context.skill,
          skillId: context.skillId,
          skillVersionId: context.skillVersionId,
          passportId: context.passportId || undefined,
          certificateSummary: context.certificateSummary,
        }),
        approvedBy: args.actorId,
        approvedAt: reviewedAt,
        auditPolicy: { ...auditPolicy, adoptionReview: reviewRecord },
        riskNotes: appendReviewNote(registry.riskNotes, args.note, '批量刷新采用基线'),
      }
    } else {
      data = {
        auditPolicy: { ...auditPolicy, adoptionReview: reviewRecord },
        riskNotes: action === 'accept_risk'
          ? appendReviewNote(registry.riskNotes, args.note, '批量接受准入漂移风险')
          : appendReviewNote(registry.riskNotes, args.note, '批量标记准入已复核'),
      }
    }
    Object.keys(data).forEach((key) => data[key] === undefined && delete data[key])
    const updated = await payload.update({
      collection: 'enterprise-registries' as any,
      id,
      data,
      depth: 0,
      overrideAccess: true,
    })
    results.push({
      id,
      ok: true,
      action,
      previousReview: before.review,
      registry: publicEnterpriseRegistry(updated),
    })
  }

  return {
    ok: true,
    organizationId: args.organizationId,
    action,
    summary: {
      requested: registryIds.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
    },
    results,
  }
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
