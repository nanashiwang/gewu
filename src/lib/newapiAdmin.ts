// New API 中转「管理 API」抽象层（子令牌配额管理）——变现骨架的地基。
//
// 设计前提：权威的 credit 余额存在本平台 `credit-logs`（不变量 creditBalance==SUM(logs)），
// 向 New API 网关同步子令牌配额只是**副作用**。因此：
//   · stub 模式（默认 / 未配置 env）：模拟成功、不发外部请求 → 整个变现闭环本地可跑通，只是不真正下发网关配额；
//   · real 模式（配置了 NEWAPI_ADMIN_BASE_URL + NEWAPI_ADMIN_KEY）：按 QuantumNous/new-api 源码规格调真实接口。
//
// 上线前用你实例小额真跑校验（总纲 §7 B）：鉴权前缀(NEWAPI_AUTH_BEARER)、list/log 响应包裹、log 查询参数名、
// `NEWAPI_CREDIT_TO_QUOTA`（1 credit=多少 quota，按你的售价校准）。
import { redactNewApiProbeText } from './newapiProbe'
import { requireApprovedPlatformModelList } from './constants'

type Env = Record<string, string | undefined>

export class NewApiAdminError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'NewApiAdminError'
  }
}

export interface SubToken {
  tokenName: string
  key?: string // 子令牌的 sk- 密钥（真实模式建成后返回，供用户 BYOK / 平台代跑）
  tokenId?: number
  simulated: boolean
}
export interface QuotaResult {
  ok: boolean
  remainQuota?: number
  simulated: boolean
}
export interface UsageResult {
  costCents: number // New API 按 quota 实际扣费折算的分；真钱毛利还要和本地 charged credit 做差
  usedQuota: number // 原始 quota 消费，用于校准刻度；/api/log 有调用但无 quota 时不能验收真钱闭环
  calls: number
  byModel: UsageByModel[]
  missingModelCalls: number
  simulated: boolean
}

export interface UsageByModel {
  modelName: string
  costCents: number
  usedQuota: number
  tokenPricedQuota: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface NewApiModelPricing {
  modelName: string
  quotaType: number
  modelRatio: number
  modelPrice: number
  completionRatio: number
  supportsCacheRead: boolean
  cacheRatio: number
  supportsCacheCreation: boolean
  cacheCreationRatio: number
  groupRatio: number
}

export interface PricingResult {
  models: NewApiModelPricing[]
  group: string
  quotaPerUnit: number
  usdToCny: number
  simulated: boolean
}

export interface NewApiAdmin {
  readonly mode: 'real' | 'stub'
  /** 为用户建/确保受限子令牌（低价分组 + 配额 + TTL），返回 token_name（约定 gw_<userId>） */
  provisionSubToken(userId: string): Promise<SubToken>
  /** 将子令牌配额同步为指定 credit 余额对应的绝对值（权威账本在本平台） */
  setQuotaToCredits(userId: string, credits: number): Promise<QuotaResult>
  /** 增/减子令牌配额；deltaCredits 可负（credit→quota 刻度按 CREDIT_TO_QUOTA 映射） */
  adjustQuota(userId: string, deltaCredits: number): Promise<QuotaResult>
  /** 拉取用户自某时刻起的用量与消费（喂护城河 + 毛利对账） */
  fetchUsage(userId: string, sinceMs: number): Promise<UsageResult>
  /** 拉取 New API 暴露的模型价格/倍率快照，用 token 用量重算真钱成本 */
  fetchPricing(): Promise<PricingResult>
}

const adminBase = (env: Env = process.env) => env.NEWAPI_ADMIN_BASE_URL?.replace(/\/$/, '')
const adminKey = (env: Env = process.env) => env.NEWAPI_ADMIN_KEY

// credit ↔ 网关 quota 刻度映射：1 credit = 多少 quota。
// 校准：new-api QuotaPerUnit=500000(即 500000 quota=$1)。若 1 credit=¥0.01、你按 ¥Y 卖 500000 quota，
// 则 CREDIT_TO_QUOTA = 0.01/(Y/500000) = 5000/Y。占位默认 700(约 ¥7≈$1 时)，上线前用真实计价校准。
export const DEFAULT_CREDIT_TO_QUOTA = 700
export const CREDIT_TO_QUOTA = DEFAULT_CREDIT_TO_QUOTA
const DEFAULT_SUB_TOKEN_TTL_DAYS = 7
const MIN_EXPIRY_PATCH_WINDOW_SECONDS = 24 * 60 * 60
const TOKEN_LIST_PAGE_SIZE = 100
const TOKEN_LIST_MAX_PAGES = 50
const USAGE_LOG_PAGE_SIZE = 1000
const USAGE_LOG_MAX_PAGES = 100
const MAX_LOG_FUTURE_SKEW_MS = 5 * 60 * 1000
const TOKEN_STATUS_ENABLED = 1
const TOKEN_STATUS_DISABLED = 2

export function getCreditToQuota(
  env: Record<string, string | undefined> = process.env,
  opts: { requireExplicit?: boolean } = {},
): number {
  const raw = env.NEWAPI_CREDIT_TO_QUOTA?.trim()
  if (!raw && opts.requireExplicit) {
    throw new NewApiAdminError('NEWAPI_CREDIT_TO_QUOTA 必须显式配置；真实模式禁止使用开发默认 quota 刻度')
  }
  if (!raw) return DEFAULT_CREDIT_TO_QUOTA
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new NewApiAdminError('NEWAPI_CREDIT_TO_QUOTA 必须是正数；禁止用非法 quota 刻度同步真钱配额')
  }
  return n
}

export function isRealMode(env: Env = process.env): boolean {
  return !!(adminBase(env) && adminKey(env))
}

// 令牌命名约定：1 个 New API 账号 = 全体用户，靠子令牌名隔离
export function subTokenName(userId: string): string {
  return `gw_${userId}`
}

function platformModelLimits(env: Env = process.env): string {
  return requireApprovedPlatformModelList(env).join(',')
}

function configuredSubTokenGroup(env: Env = process.env): string | undefined {
  const group = env.NEWAPI_SUB_GROUP?.trim()
  if (group) return group
  if (env.ALLOW_DEFAULT_NEWAPI_SUB_GROUP === '1') return undefined
  throw new NewApiAdminError(
    'NEWAPI_SUB_GROUP 必须配置为低价/受限分组；如已确认 New API 默认分组安全，显式设置 ALLOW_DEFAULT_NEWAPI_SUB_GROUP=1',
  )
}

function subTokenTtlSeconds(env: Env = process.env): number {
  const raw = env.NEWAPI_SUB_TOKEN_TTL_DAYS?.trim()
  const days = raw ? Number(raw) : DEFAULT_SUB_TOKEN_TTL_DAYS
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new NewApiAdminError('NEWAPI_SUB_TOKEN_TTL_DAYS 必须是 1-365 天的正数，禁止创建永不过期或异常长效子令牌')
  }
  return Math.round(days * 24 * 60 * 60)
}

function nextSubTokenExpiredTime(ttlSeconds = subTokenTtlSeconds()): number {
  return Math.floor(Date.now() / 1000) + ttlSeconds
}

function tokenExpiryUnsafe(tok: any, ttlSeconds = subTokenTtlSeconds()): boolean {
  const raw = tok?.expired_time ?? tok?.expiredTime
  const n = typeof raw === 'string' ? Number(raw) : raw
  const now = Math.floor(Date.now() / 1000)
  return !Number.isFinite(n) || n <= 0 || n < now + MIN_EXPIRY_PATCH_WINDOW_SECONDS || n > now + ttlSeconds * 2
}

class StubAdmin implements NewApiAdmin {
  readonly mode = 'stub' as const
  async provisionSubToken(userId: string): Promise<SubToken> {
    return { tokenName: subTokenName(userId), simulated: true }
  }
  async setQuotaToCredits(_userId: string, _credits: number): Promise<QuotaResult> {
    return { ok: true, simulated: true }
  }
  async adjustQuota(_userId: string, _deltaCredits: number): Promise<QuotaResult> {
    return { ok: true, simulated: true }
  }
  async fetchUsage(_userId: string, _sinceMs: number): Promise<UsageResult> {
    return { costCents: 0, usedQuota: 0, calls: 0, byModel: [], missingModelCalls: 0, simulated: true }
  }
  async fetchPricing(): Promise<PricingResult> {
    return { models: [], group: 'stub', quotaPerUnit: 500000, usdToCny: 7, simulated: true }
  }
}

// ── RealAdmin：按 QuantumNous/new-api 源码规格实现 ──
// 鉴权：Authorization: <access_token>(默认裸值，NEWAPI_AUTH_BEARER=1 加 Bearer 前缀) + New-Api-User: <userId>
// 端点：POST/PUT/GET /api/token/、GET /api/log/。字段名取自源码 model/token.go、model/log.go。
// ⚠️ 上线前用你实例小额真跑校验：鉴权前缀、list/log 响应包裹结构、log 查询参数名。
class RealAdmin implements NewApiAdmin {
  readonly mode = 'real' as const
  private base: string
  private resolvedUsageLogPath: '/api/log/' | '/api/log/self' | null = null

  constructor(private env: Env = process.env) {
    this.base = adminBase(env) as string
  }

  private headers(): Record<string, string> {
    const key = this.env.NEWAPI_ADMIN_KEY || ''
    const auth = this.env.NEWAPI_AUTH_BEARER === '1' ? `Bearer ${key}` : key
    return {
      'Content-Type': 'application/json',
      Authorization: auth,
      'New-Api-User': this.env.NEWAPI_ADMIN_USER_ID || '',
    }
  }

  private async req(path: string, method: string, body?: unknown): Promise<any> {
    if (!this.env.NEWAPI_ADMIN_USER_ID) {
      throw new NewApiAdminError('缺少 NEWAPI_ADMIN_USER_ID（New-Api-User 头需要平台账号数字 ID）')
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(),
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text().catch(() => '')
    let json: any = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new NewApiAdminError(`New API 返回非 JSON（${res.status}）: ${redactNewApiProbeText(text.slice(0, 200), [this.env.NEWAPI_ADMIN_KEY || ''])}`)
    }
    if (!res.ok || json?.success === false) {
      const message = redactNewApiProbeText(String(json?.message || text.slice(0, 200)), [this.env.NEWAPI_ADMIN_KEY || ''])
      throw new NewApiAdminError(`New API ${method} ${path} 失败(${res.status}): ${message}`)
    }
    return json
  }

  async fetchPricing(): Promise<PricingResult> {
    const pricingJson = await this.req('/api/pricing', 'GET')
    const statusJson = await this.req('/api/status', 'GET')
    const pricingRecords = this.records(pricingJson)
    const groupRatios =
      pricingJson?.group_ratio && typeof pricingJson.group_ratio === 'object'
        ? pricingJson.group_ratio
        : pricingJson?.data?.group_ratio && typeof pricingJson.data.group_ratio === 'object'
          ? pricingJson.data.group_ratio
          : {}
    const group = configuredSubTokenGroup(this.env) || 'default'
    const rawGroupRatio = groupRatios[group] ?? (group === 'default' ? 1 : undefined)
    const groupRatio = Number(rawGroupRatio)
    if (!Number.isFinite(groupRatio) || groupRatio <= 0) {
      throw new NewApiAdminError(`New API /api/pricing 未返回分组 ${group} 的有效 group_ratio，不能按 token 价格验收真钱成本`)
    }
    const status = statusJson?.data ?? statusJson
    const quotaPerUnit = Number(status?.quota_per_unit || 500000)
    const usdToCny = Number(status?.usd_exchange_rate || this.env.NEWAPI_USD_EXCHANGE_RATE_CNY)
    if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
      throw new NewApiAdminError('New API /api/status 未返回有效 quota_per_unit，不能按 token 价格验收真钱成本')
    }
    if (!Number.isFinite(usdToCny) || usdToCny <= 0) {
      throw new NewApiAdminError('New API /api/status 未返回有效 usd_exchange_rate，不能把官方美元价格折算为人民币成本')
    }
    const models = pricingRecords.map((r: any) => parseNewApiModelPricing(r, groupRatio)).filter(Boolean) as NewApiModelPricing[]
    if (models.length === 0) {
      throw new NewApiAdminError('New API /api/pricing 未返回模型价格，不能按 token 价格验收真钱成本')
    }
    return { models, group, quotaPerUnit, usdToCny, simulated: false }
  }

  // 列表响应包裹结构在不同版本间有差异，容错提取记录数组
  private records(json: any): any[] {
    const d = json?.data ?? json
    if (Array.isArray(d)) return d
    return d?.items || d?.records || d?.list || []
  }

  private async findTokensByName(name: string): Promise<any[]> {
    // 分页扫描本账号令牌找同名（子令牌都在平台账号下）；超过扫描上限直接 fail-closed，避免漏掉同名旧令牌。
    const hits: any[] = []
    for (let p = 1; p <= TOKEN_LIST_MAX_PAGES; p++) {
      const json = await this.req(`/api/token/?p=${p}&page_size=${TOKEN_LIST_PAGE_SIZE}`, 'GET')
      const recs = this.records(json)
      hits.push(...recs.filter((t: any) => t?.name === name))
      if (recs.length < TOKEN_LIST_PAGE_SIZE) break
      if (p === TOKEN_LIST_MAX_PAGES) {
        throw new NewApiAdminError('New API token 列表超过扫描上限，不能证明子令牌唯一；请先清理/缩小平台账号令牌数量')
      }
    }
    return hits
  }

  private quotaLimitedTokenPayload(tok: any, remainQuota: number, modelLimits: string, ttlSeconds: number): any {
    const group = configuredSubTokenGroup(this.env)
    const safeRemainQuota = Math.max(0, Math.round(remainQuota || 0))
    return {
      ...tok,
      status: safeRemainQuota > 0 ? TOKEN_STATUS_ENABLED : TOKEN_STATUS_DISABLED,
      remain_quota: safeRemainQuota,
      unlimited_quota: false,
      expired_time: nextSubTokenExpiredTime(ttlSeconds),
      model_limits_enabled: true,
      model_limits: modelLimits,
      ...(group ? { group } : {}),
    }
  }

  private async writeQuotaLimitedToken(tok: any, remainQuota: number, modelLimits: string, ttlSeconds: number): Promise<void> {
    const payload = this.quotaLimitedTokenPayload(tok, remainQuota, modelLimits, ttlSeconds)
    const currentRemainQuota = Number(tok?.remain_quota || 0)
    const currentStatus = Number(tok?.status || 0)
    if (payload.remain_quota <= 0) {
      const disabledPayload = { ...payload, status: TOKEN_STATUS_DISABLED }
      await this.req('/api/token/', 'PUT', disabledPayload)
      await this.req('/api/token/?status_only=1', 'PUT', disabledPayload)
      return
    }
    // New API validates "enable" against the old DB row before applying the new quota.
    // If a zero-quota token is topped up, write the quota while disabled, then enable it.
    if (currentRemainQuota <= 0 || currentStatus !== TOKEN_STATUS_ENABLED) {
      const disabledPayload = { ...payload, status: TOKEN_STATUS_DISABLED }
      await this.req('/api/token/', 'PUT', disabledPayload)
      await this.req('/api/token/?status_only=1', 'PUT', { ...disabledPayload, status: TOKEN_STATUS_ENABLED })
      return
    }
    await this.req('/api/token/', 'PUT', payload)
  }

  private async tokenFullKey(tok: any): Promise<string | undefined> {
    const raw = typeof tok?.key === 'string' ? tok.key.trim() : ''
    if (raw && !raw.includes('*')) return raw
    if (!tok?.id) return raw || undefined
    const json = await this.req(`/api/token/${tok.id}/key`, 'GET')
    const key = json?.data?.key ?? json?.key
    return typeof key === 'string' && key.trim() ? key.trim() : raw || undefined
  }

  private tokenNeedsSafetyPatch(tok: any, modelLimits: string, ttlSeconds: number): boolean {
    const group = configuredSubTokenGroup(this.env)
    return (
      tok.unlimited_quota === true ||
      tokenExpiryUnsafe(tok, ttlSeconds) ||
      tok.model_limits_enabled !== true ||
      String(tok.model_limits || '') !== modelLimits ||
      Boolean(group && String(tok.group || '') !== group)
    )
  }

  private async requireUniqueTokenByName(name: string, modelLimits: string, ttlSeconds: number): Promise<any | null> {
    const hits = await this.findTokensByName(name)
    if (hits.length <= 1) return hits[0] || null
    for (const tok of hits) {
      await this.writeQuotaLimitedToken(tok, 0, modelLimits, ttlSeconds)
    }
    throw new NewApiAdminError(`发现 ${hits.length} 个同名 New API 子令牌 ${name}，已尝试全部清零；请人工删除重复令牌后重试`)
  }

  async provisionSubToken(userId: string): Promise<SubToken> {
    const group = configuredSubTokenGroup(this.env)
    const ttlSeconds = subTokenTtlSeconds(this.env)
    const modelLimits = platformModelLimits(this.env)
    const name = subTokenName(userId)
    const existing = await this.requireUniqueTokenByName(name, modelLimits, ttlSeconds)
    if (existing) {
      if (this.tokenNeedsSafetyPatch(existing, modelLimits, ttlSeconds)) {
        await this.writeQuotaLimitedToken(existing, existing.remain_quota || 0, modelLimits, ttlSeconds)
      }
      return { tokenName: name, key: await this.tokenFullKey(existing), tokenId: existing.id, simulated: false }
    }
    await this.req('/api/token/', 'POST', {
      name,
      remain_quota: 0,
      unlimited_quota: false,
      expired_time: nextSubTokenExpiredTime(ttlSeconds),
      group: group || '',
      model_limits_enabled: true,
      model_limits: modelLimits,
    })
    const created = await this.requireUniqueTokenByName(name, modelLimits, ttlSeconds)
    return { tokenName: name, key: await this.tokenFullKey(created), tokenId: created?.id, simulated: false }
  }

  async adjustQuota(userId: string, deltaCredits: number): Promise<QuotaResult> {
    const name = subTokenName(userId)
    const quotaPerCredit = getCreditToQuota(this.env, { requireExplicit: true })
    configuredSubTokenGroup(this.env)
    const ttlSeconds = subTokenTtlSeconds(this.env)
    const modelLimits = platformModelLimits(this.env)
    const tok = await this.requireUniqueTokenByName(name, modelLimits, ttlSeconds)
    if (!tok) throw new NewApiAdminError(`子令牌 ${name} 不存在，请先 provisionSubToken`)
    const deltaQuota = Math.round(deltaCredits * quotaPerCredit)
    const newRemain = Math.max(0, (tok.remain_quota || 0) + deltaQuota)
    // PUT 传完整令牌对象 + 改后的 remain_quota（绝对值），并强制关闭无限配额。
    await this.writeQuotaLimitedToken(tok, newRemain, modelLimits, ttlSeconds)
    return { ok: true, remainQuota: newRemain, simulated: false }
  }

  async setQuotaToCredits(userId: string, credits: number): Promise<QuotaResult> {
    const name = subTokenName(userId)
    const quotaPerCredit = getCreditToQuota(this.env, { requireExplicit: true })
    configuredSubTokenGroup(this.env)
    const ttlSeconds = subTokenTtlSeconds(this.env)
    const modelLimits = platformModelLimits(this.env)
    const tok = await this.requireUniqueTokenByName(name, modelLimits, ttlSeconds)
    if (!tok) throw new NewApiAdminError(`子令牌 ${name} 不存在，请先 provisionSubToken`)
    const remainQuota = Math.max(0, Math.round(Math.max(0, credits || 0) * quotaPerCredit))
    await this.writeQuotaLimitedToken(tok, remainQuota, modelLimits, ttlSeconds)
    return { ok: true, remainQuota, simulated: false }
  }

  private usageLogPath(path: '/api/log/' | '/api/log/self', query: string): string {
    return path === '/api/log/self' ? `${path}?${query}` : `${path}?${query}`
  }

  private usageLogScope(): 'admin' | 'self' | 'auto' {
    const raw = (this.env.NEWAPI_LOG_SCOPE || 'auto').trim().toLowerCase()
    if (raw === 'admin' || raw === 'self' || raw === 'auto') return raw
    throw new NewApiAdminError('NEWAPI_LOG_SCOPE 必须是 admin/self/auto')
  }

  private isLogPermissionError(e: unknown): boolean {
    const msg = (e as Error)?.message || ''
    return msg.includes('/api/log/') && (msg.includes('权限不足') || msg.includes('无权') || msg.includes('forbidden'))
  }

  async fetchUsage(userId: string, sinceMs: number): Promise<UsageResult> {
    const scope = this.usageLogScope()
    if (scope === 'admin') return this.fetchUsageViaLogPath('/api/log/', userId, sinceMs)
    if (scope === 'self') return this.fetchUsageViaLogPath('/api/log/self', userId, sinceMs)
    if (this.resolvedUsageLogPath) return this.fetchUsageViaLogPath(this.resolvedUsageLogPath, userId, sinceMs)
    try {
      const usage = await this.fetchUsageViaLogPath('/api/log/', userId, sinceMs)
      this.resolvedUsageLogPath = '/api/log/'
      return usage
    } catch (e) {
      if (!this.isLogPermissionError(e)) throw e
      const usage = await this.fetchUsageViaLogPath('/api/log/self', userId, sinceMs)
      this.resolvedUsageLogPath = '/api/log/self'
      return usage
    }
  }

  private async fetchUsageViaLogPath(
    logPath: '/api/log/' | '/api/log/self',
    userId: string,
    sinceMs: number,
  ): Promise<UsageResult> {
    const quotaPerCredit = getCreditToQuota(this.env, { requireExplicit: true })
    const expectedTokenName = subTokenName(userId)
    const start = Math.floor(sinceMs / 1000)
    let totalQuota = 0
    let calls = 0
    let missingModelCalls = 0
    const byModelQuota = new Map<
      string,
      {
        usedQuota: number
        tokenPricedQuota: number
        calls: number
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        cacheCreationTokens: number
      }
    >()
    // type=2 消费；按子令牌名过滤；起始时间戳(秒)。分页拉全，避免高频用户月账单被第一页截断。
    for (let p = 1; p <= USAGE_LOG_MAX_PAGES; p++) {
      const query = `type=2&token_name=${encodeURIComponent(expectedTokenName)}&start_timestamp=${start}&p=${p}&page_size=${USAGE_LOG_PAGE_SIZE}`
      const json = await this.req(
        this.usageLogPath(logPath, query),
        'GET',
      )
      const recs = this.records(json)
      calls += recs.length
      for (const r of recs) {
        requireNoAmbiguousRefundLog(r)
        requireLogType(r)
        requireLogTokenName(r, expectedTokenName)
        requireLogTimestamp(r, start * 1000)
        const quota = requireLogQuota(r)
        totalQuota += quota
        const modelName = logModelName(r)
        if (!modelName) {
          missingModelCalls++
        } else {
          const tokens = logTokenUsage(r)
          const tokenPricedQuota = logTokenPricedQuota(r, tokens)
          const row = byModelQuota.get(modelName) || {
            usedQuota: 0,
            tokenPricedQuota: 0,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          }
          row.usedQuota += quota
          row.tokenPricedQuota += tokenPricedQuota
          row.calls += 1
          row.inputTokens += tokens.inputTokens
          row.outputTokens += tokens.outputTokens
          row.cacheReadTokens += tokens.cacheReadTokens
          row.cacheCreationTokens += tokens.cacheCreationTokens
          byModelQuota.set(modelName, row)
        }
      }
      if (recs.length < USAGE_LOG_PAGE_SIZE) break
      if (p === USAGE_LOG_MAX_PAGES) {
        throw new NewApiAdminError('New API /api/log 超过分页扫描上限，不能验收真钱用量；请缩短对账窗口或提高导出能力')
      }
    }
    // quota → 分：与 credit 同刻度反向映射（1 credit=1 分=CREDIT_TO_QUOTA quota）
    const costCents = Math.round(totalQuota / quotaPerCredit)
    const byModel = Array.from(byModelQuota.entries())
      .map(([modelName, row]) => ({
        modelName,
        usedQuota: row.usedQuota,
        tokenPricedQuota: row.tokenPricedQuota,
        calls: row.calls,
        costCents: Math.round(row.usedQuota / quotaPerCredit),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
      }))
      .sort((a, b) => b.usedQuota - a.usedQuota || a.modelName.localeCompare(b.modelName))
    return { costCents, usedQuota: totalQuota, calls, byModel, missingModelCalls, simulated: false }
  }
}

export function logQuota(record: any): number {
  const raw = record?.quota ?? record?.used_quota ?? record?.quota_used ?? 0
  const n = typeof raw === 'string' ? Number(raw) : raw
  return Number.isFinite(n) && n > 0 ? n : 0
}

function requireLogQuota(record: any): number {
  const n = logQuota(record)
  if (n <= 0) {
    throw new NewApiAdminError('New API /api/log 记录缺少有效 quota 字段，不能验收真钱用量')
  }
  return n
}

export function logTokenName(record: any): string {
  const raw = record?.token_name ?? record?.tokenName ?? record?.token_name_text ?? record?.token
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object' && typeof raw.name === 'string') return raw.name.trim()
  return ''
}

export function logModelName(record: any): string {
  const raw = record?.model_name ?? record?.modelName ?? record?.model ?? record?.model_id ?? record?.modelId
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object') {
    for (const key of ['name', 'model_name', 'modelName', 'id']) {
      if (typeof raw[key] === 'string' && raw[key].trim()) return raw[key].trim()
    }
  }
  return ''
}

function logNumber(record: any, keys: string[]): number {
  for (const key of keys) {
    const raw = record?.[key]
    const n = typeof raw === 'string' ? Number(raw) : raw
    if (Number.isFinite(n)) return Math.max(0, Math.round(n))
  }
  return 0
}

function parseLogOther(record: any): any {
  const raw = record?.other ?? record?.Other
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return {}
}

export function logTokenUsage(record: any): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
} {
  const other = parseLogOther(record)
  const promptTokens = logNumber(record, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens'])
  const outputTokens = logNumber(record, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens'])
  const cacheReadTokens =
    logNumber(record, ['cache_read_tokens', 'cacheReadTokens', 'prompt_cache_hit_tokens', 'promptCacheHitTokens']) ||
    logNumber(other, ['cache_tokens', 'cacheTokens', 'cache_read_tokens', 'cacheReadTokens'])
  const cacheCreationTokens =
    logNumber(record, ['cache_creation_tokens', 'cacheCreationTokens', 'cache_write_tokens', 'cacheWriteTokens']) ||
    logNumber(other, ['cache_creation_tokens', 'cacheCreationTokens']) ||
    logNumber(other, ['cache_creation_tokens_5m', 'cacheCreationTokens5m']) +
      logNumber(other, ['cache_creation_tokens_1h', 'cacheCreationTokens1h'])
  const anthropic = other?.claude === true || String(other?.usage_semantic || '').toLowerCase() === 'anthropic'
  const inputTokens = anthropic ? promptTokens : Math.max(0, promptTokens - cacheReadTokens - cacheCreationTokens)
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}

export function logTokenPricedQuota(
  record: any,
  tokens = logTokenUsage(record),
): number {
  const other = parseLogOther(record)
  const modelRatio = Number(other?.model_ratio)
  const groupRatio = Number(other?.group_ratio)
  const completionRatio = Number(other?.completion_ratio)
  if (!Number.isFinite(modelRatio) || modelRatio <= 0 || !Number.isFinite(groupRatio) || groupRatio <= 0) return 0
  if (!Number.isFinite(completionRatio) || completionRatio < 0) return 0
  const cacheRatio = Number.isFinite(Number(other?.cache_ratio)) ? Number(other.cache_ratio) : 0
  const cacheCreationRatio = Number.isFinite(Number(other?.cache_creation_ratio)) ? Number(other.cache_creation_ratio) : 0
  const raw =
    tokens.inputTokens +
    tokens.outputTokens * completionRatio +
    tokens.cacheReadTokens * cacheRatio +
    tokens.cacheCreationTokens * cacheCreationRatio
  return Math.max(0, Math.round(raw * modelRatio * groupRatio))
}

export function parseNewApiModelPricing(record: any, groupRatio: number): NewApiModelPricing | null {
  const modelName = typeof record?.model_name === 'string' ? record.model_name.trim() : ''
  if (!modelName) return null
  const quotaType = Number(record?.quota_type ?? 0)
  const modelRatio = Number(record?.model_ratio ?? 0)
  const modelPrice = Number(record?.model_price ?? 0)
  const completionRatio = Number(record?.completion_ratio ?? 0)
  const supportsCacheRead = record?.supports_cache_read === true
  const cacheRatio = Number(record?.cache_ratio ?? 0)
  const supportsCacheCreation = record?.supports_cache_creation === true
  const cacheCreationRatio = Number(record?.cache_creation_ratio ?? 0)
  return {
    modelName,
    quotaType: Number.isFinite(quotaType) ? quotaType : 0,
    modelRatio: Number.isFinite(modelRatio) ? modelRatio : 0,
    modelPrice: Number.isFinite(modelPrice) ? modelPrice : 0,
    completionRatio: Number.isFinite(completionRatio) ? completionRatio : 0,
    supportsCacheRead,
    cacheRatio: Number.isFinite(cacheRatio) ? cacheRatio : 0,
    supportsCacheCreation,
    cacheCreationRatio: Number.isFinite(cacheCreationRatio) ? cacheCreationRatio : 0,
    groupRatio,
  }
}

function requireLogTokenName(record: any, expected: string): void {
  const actual = logTokenName(record)
  if (!actual) {
    throw new NewApiAdminError('New API /api/log 记录缺少 token_name，不能证明日志属于目标子令牌')
  }
  if (actual !== expected) {
    throw new NewApiAdminError('New API /api/log 返回了非目标子令牌记录，不能验收真钱用量')
  }
}

export function logTimestampMs(record: any): number {
  const raw =
    record?.created_at ??
    record?.createdAt ??
    record?.created_time ??
    record?.createdTime ??
    record?.timestamp ??
    record?.time
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? (raw > 1e12 ? raw : raw * 1000) : 0
  if (typeof raw === 'string') {
    const s = raw.trim()
    const n = Number(s)
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000
    const parsed = Date.parse(s)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function requireLogTimestamp(record: any, sinceMs: number): void {
  const ts = logTimestampMs(record)
  if (ts <= 0) {
    throw new NewApiAdminError('New API /api/log 记录缺少有效时间戳，不能证明 start_timestamp 过滤生效')
  }
  if (ts < sinceMs) {
    throw new NewApiAdminError('New API /api/log 返回了早于 start_timestamp 的记录，不能验收真钱用量')
  }
  if (ts > Date.now() + MAX_LOG_FUTURE_SKEW_MS) {
    throw new NewApiAdminError('New API /api/log 返回了未来时间记录，不能验收真钱用量')
  }
}

export function logType(record: any): number {
  const raw = record?.type ?? record?.log_type ?? record?.logType
  const n = typeof raw === 'string' ? Number(raw) : raw
  return Number.isFinite(n) ? n : NaN
}

function requireLogType(record: any): void {
  const n = logType(record)
  if (n !== 2) {
    throw new NewApiAdminError('New API /api/log 记录缺少消费 type=2，不能证明日志属于模型消费')
  }
}

function truthyLogFlag(value: any): boolean {
  if (value === true) return true
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
  if (typeof value === 'string') return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase())
  return false
}

function positiveLogNumber(record: any, keys: string[]): boolean {
  return keys.some((key) => {
    const raw = record?.[key]
    const n = typeof raw === 'string' ? Number(raw) : raw
    return Number.isFinite(n) && n > 0
  })
}

function parseStreamStatus(record: any): any {
  const raw = record?.stream_status ?? record?.streamStatus
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return null
}

function requireNoAmbiguousRefundLog(record: any): void {
  const type = logType(record)
  if (type === 6) {
    throw new NewApiAdminError('New API /api/log 返回了退款记录，不能验收真钱用量')
  }
  if (
    truthyLogFlag(record?.is_refund) ||
    truthyLogFlag(record?.isRefund) ||
    truthyLogFlag(record?.refunded) ||
    truthyLogFlag(record?.is_refunded) ||
    positiveLogNumber(record, ['refund_quota', 'refundQuota', 'refunded_quota', 'refundedQuota'])
  ) {
    throw new NewApiAdminError('New API /api/log 返回了退款相关记录，不能验收真钱用量')
  }
  const streamStatus = parseStreamStatus(record)
  const status = typeof streamStatus?.status === 'string' ? streamStatus.status.toLowerCase() : ''
  const endReason = typeof streamStatus?.end_reason === 'string' ? streamStatus.end_reason.toLowerCase() : ''
  if (status === 'error' || status === 'failed' || ['client_gone', 'context_canceled', 'context canceled'].includes(endReason)) {
    throw new NewApiAdminError('New API /api/log 返回了异常流式结算记录，不能验收真钱用量')
  }
}

// 工厂（不缓存，供测试按 env 切换）
export function createNewApiAdmin(env: Env = process.env): NewApiAdmin {
  return isRealMode(env) ? new RealAdmin(env) : new StubAdmin()
}

export function getNewApiAdmin(env: Env = process.env): NewApiAdmin {
  return createNewApiAdmin(env)
}
