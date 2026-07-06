export interface NewApiProbeCheck {
  path: string
  ok: boolean
  message?: string
  recordCount?: number
  ambiguousSettlementCount?: number
}

export interface NewApiProbeResult extends NewApiProbeCheck {
  status: number
  success?: unknown
  shape: string
  recordCount: number
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{
  status: number
  ok: boolean
  text(): Promise<string>
}>

export interface NewApiProbeOptions {
  baseUrl?: string
  key?: string
  userId?: string
  bearer?: boolean
  timeoutMs?: number
  subGroup?: string
  fetchImpl?: FetchLike
}

function redactLiteral(text: string, value: string): string {
  if (!value || value.length < 8) return text
  return text.split(value).join('<redacted>')
}

export function redactNewApiProbeText(text: string, extraSecrets: string[] = []): string {
  let out = String(text || '')
    .replace(/sk-[A-Za-z0-9/_+\-=]{8,}/g, 'sk_<redacted>')
    .replace(/hs_[A-Za-z0-9-]+/g, 'hs_<user>')
  for (const secret of [
    process.env.NEWAPI_ADMIN_KEY || '',
    process.env.MODEL_GATEWAY_KEY || '',
    ...extraSecrets,
  ]) {
    out = redactLiteral(out, secret.trim())
  }
  return out
}

function shapeOf(json: any): string {
  const data = json?.data ?? json
  if (Array.isArray(data)) return `array(${data.length})`
  if (data && typeof data === 'object') return Object.keys(data).slice(0, 8).join(',')
  return typeof data
}

function recordsOf(json: any): any[] {
  const data = json?.data ?? json
  if (Array.isArray(data)) return data
  return data?.items || data?.records || data?.list || []
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

function logType(record: any): number {
  const raw = record?.type ?? record?.log_type ?? record?.logType
  const n = typeof raw === 'string' ? Number(raw) : raw
  return Number.isFinite(n) ? n : NaN
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

function ambiguousSettlementRecord(record: any): boolean {
  if (logType(record) === 6) return true
  if (
    truthyLogFlag(record?.is_refund) ||
    truthyLogFlag(record?.isRefund) ||
    truthyLogFlag(record?.refunded) ||
    truthyLogFlag(record?.is_refunded) ||
    positiveLogNumber(record, ['refund_quota', 'refundQuota', 'refunded_quota', 'refundedQuota'])
  ) {
    return true
  }
  const streamStatus = parseStreamStatus(record)
  const status = typeof streamStatus?.status === 'string' ? streamStatus.status.toLowerCase() : ''
  const endReason = typeof streamStatus?.end_reason === 'string' ? streamStatus.end_reason.toLowerCase() : ''
  return status === 'error' || status === 'failed' || ['client_gone', 'context_canceled', 'context canceled'].includes(endReason)
}

async function probePath(path: string, options: Required<Omit<NewApiProbeOptions, 'fetchImpl'>> & { fetchImpl: FetchLike }): Promise<NewApiProbeResult> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await options.fetchImpl(`${options.baseUrl}${path}`, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: options.bearer ? `Bearer ${options.key}` : options.key,
        'New-Api-User': options.userId,
      },
    })
  } catch (e) {
    return {
      path,
      status: 0,
      ok: false,
      message: redactNewApiProbeText((e as Error).message || String(e), [options.key]),
      shape: 'network-error',
      recordCount: 0,
    }
  }
  const text = await res.text().catch(() => '')
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }

  const records = recordsOf(json)
  const ambiguousSettlementCount = path.startsWith('/api/log')
    ? records.filter(ambiguousSettlementRecord).length
    : 0
  let semanticError = ''
  if (path.startsWith('/api/pricing')) {
    const groupRatio = json?.group_ratio ?? json?.data?.group_ratio
    const targetGroup = options.subGroup?.trim()
    if (records.length === 0) {
      semanticError = '/api/pricing 未返回模型价格'
    } else if (!groupRatio || typeof groupRatio !== 'object') {
      semanticError = '/api/pricing 未返回 group_ratio'
    } else if (targetGroup) {
      const ratio = Number(groupRatio[targetGroup])
      if (!Number.isFinite(ratio) || ratio <= 0) {
        semanticError = `/api/pricing 未返回分组 ${targetGroup} 的有效 group_ratio`
      }
    }
  } else if (path.startsWith('/api/status')) {
    const data = json?.data ?? json
    if (!Number.isFinite(Number(data?.quota_per_unit)) || Number(data?.quota_per_unit) <= 0) {
      semanticError = '/api/status 未返回有效 quota_per_unit'
    } else if (!Number.isFinite(Number(data?.usd_exchange_rate)) || Number(data?.usd_exchange_rate) <= 0) {
      semanticError = '/api/status 未返回有效 usd_exchange_rate'
    }
  }
  return {
    path,
    status: res.status,
    ok: res.ok && json?.success !== false && !semanticError,
    success: json?.success,
    message: redactNewApiProbeText(String(semanticError || json?.message || json?.error || ''), [options.key]),
    shape: shapeOf(json),
    recordCount: records.length,
    ambiguousSettlementCount,
  }
}

export async function runNewApiPermissionProbe(options: NewApiProbeOptions = {}): Promise<NewApiProbeResult[]> {
  const baseUrl = (options.baseUrl || process.env.NEWAPI_ADMIN_BASE_URL || '').replace(/\/$/, '')
  const key = options.key || process.env.NEWAPI_ADMIN_KEY || ''
  const userId = options.userId || process.env.NEWAPI_ADMIN_USER_ID || ''
  const bearer = options.bearer ?? process.env.NEWAPI_AUTH_BEARER === '1'
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.NEWAPI_PROBE_TIMEOUT_MS || 10_000))
  const subGroup = options.subGroup ?? process.env.NEWAPI_SUB_GROUP ?? ''
  const fetchImpl = options.fetchImpl || fetch
  if (!baseUrl || !key || !userId) {
    throw new Error('缺少 NEWAPI_ADMIN_BASE_URL / NEWAPI_ADMIN_KEY / NEWAPI_ADMIN_USER_ID')
  }

  const impossibleTokenName = `hs_preflight_impossible_${Date.now()}`
  const futureStartTimestamp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60
  return Promise.all([
    probePath('/api/token/?p=1&page_size=1', { baseUrl, key, userId, bearer, timeoutMs, subGroup, fetchImpl }),
    probePath('/api/log/?p=1&page_size=1', { baseUrl, key, userId, bearer, timeoutMs, subGroup, fetchImpl }),
    probePath('/api/log/?type=2&p=1&page_size=5', { baseUrl, key, userId, bearer, timeoutMs, subGroup, fetchImpl }),
    probePath(`/api/log/?type=2&token_name=${impossibleTokenName}&p=1&page_size=1`, {
      baseUrl,
      key,
      userId,
      bearer,
      timeoutMs,
      subGroup,
      fetchImpl,
    }),
    probePath(`/api/log/?type=2&start_timestamp=${futureStartTimestamp}&p=1&page_size=1`, {
      baseUrl,
      key,
      userId,
      bearer,
      timeoutMs,
      subGroup,
      fetchImpl,
    }),
    probePath('/api/log/self?p=1&page_size=1', { baseUrl, key, userId, bearer, timeoutMs, subGroup, fetchImpl }),
    probePath('/api/log/self?type=2&p=1&page_size=5', { baseUrl, key, userId, bearer, timeoutMs, subGroup, fetchImpl }),
    probePath(`/api/log/self?type=2&token_name=${impossibleTokenName}&p=1&page_size=1`, {
      baseUrl,
      key,
      userId,
      bearer,
      timeoutMs,
      subGroup,
      fetchImpl,
    }),
    probePath(`/api/log/self?type=2&start_timestamp=${futureStartTimestamp}&p=1&page_size=1`, {
      baseUrl,
      key,
      userId,
      bearer,
      timeoutMs,
      subGroup,
      fetchImpl,
    }),
    probePath('/api/pricing', { baseUrl, key, userId, bearer, timeoutMs, subGroup, fetchImpl }),
    probePath('/api/status', { baseUrl, key, userId, bearer, timeoutMs, subGroup, fetchImpl }),
  ])
}

export function classifyNewApiProbe(checks: NewApiProbeCheck[]): {
  tokenOK: boolean
  logOK: boolean
  logFilterOK: boolean
  logTimeFilterOK: boolean
  logSettlementOK: boolean
  pricingOK: boolean
  statusOK: boolean
  logScope: 'admin' | 'self' | 'none'
  hint: string
} {
  const tokenOK = !!checks.find((c) => c.path.startsWith('/api/token'))?.ok
  const adminLogOK = !!checks.find((c) => c.path.startsWith('/api/log/?') && !c.path.includes('type=2') && !c.path.includes('token_name=') && !c.path.includes('start_timestamp='))?.ok
  const selfLogOK = !!checks.find((c) => c.path.startsWith('/api/log/self?') && !c.path.includes('type=2') && !c.path.includes('token_name=') && !c.path.includes('start_timestamp='))?.ok
  const logScope = adminLogOK ? 'admin' : selfLogOK ? 'self' : 'none'
  const logOK = logScope !== 'none'
  const logPrefix = logScope === 'self' ? '/api/log/self?' : '/api/log/?'
  const settlementCheck = checks.find((c) => c.path.includes(`${logPrefix}type=2&p=`))
  const logSettlementOK = !!(settlementCheck?.ok && (settlementCheck.ambiguousSettlementCount || 0) === 0)
  const filterCheck = checks.find((c) => c.path.startsWith(logPrefix) && c.path.includes('token_name=hs_preflight_impossible'))
  const logFilterOK = !!(filterCheck?.ok && (filterCheck.recordCount || 0) === 0)
  const timeFilterCheck = checks.find((c) => c.path.startsWith(logPrefix) && c.path.includes('start_timestamp='))
  const logTimeFilterOK = !!(timeFilterCheck?.ok && (timeFilterCheck.recordCount || 0) === 0)
  const pricingOK = !!checks.find((c) => c.path.startsWith('/api/pricing'))?.ok
  const statusOK = !!checks.find((c) => c.path.startsWith('/api/status'))?.ok
  let hint = 'New API 管理权限正常，可以进入小额闭环校准。'
  if (tokenOK && logScope === 'self' && logFilterOK && logTimeFilterOK && logSettlementOK && pricingOK && statusOK) {
    hint = 'New API admin /api/log 不可用，但 /api/log/self 可用；可按 token_name 拉当前账号下子令牌日志，进入小额闭环校准。'
  } else if (tokenOK && !logOK) {
    hint = '管理 access token 可管理子令牌，但 /api/log 与 /api/log/self 都不可用；不能用 newapi 真值回填毛利，兑换池必须保持关闭。'
  } else if (tokenOK && logOK && !logFilterOK) {
    hint = 'New API /api/log 可访问，但 token_name 过滤不可证明有效；不能验收真钱用量，兑换池必须保持关闭。'
  } else if (tokenOK && logOK && logFilterOK && !logTimeFilterOK) {
    hint = 'New API /api/log 可访问，但 start_timestamp 过滤不可证明有效；不能验收真钱用量，兑换池必须保持关闭。'
  } else if (tokenOK && logOK && logFilterOK && logTimeFilterOK && !logSettlementOK) {
    hint = 'New API /api/log 样本包含退款/异常流式结算或样本查询不可用；不能验收真钱用量，兑换池必须保持关闭。'
  } else if (tokenOK && logOK && logFilterOK && logTimeFilterOK && logSettlementOK && !pricingOK) {
    hint = 'New API /api/pricing 不可用或价格快照不完整；不能用 token×价格精算成本，兑换池必须保持关闭。'
  } else if (tokenOK && logOK && logFilterOK && logTimeFilterOK && logSettlementOK && pricingOK && !statusOK) {
    hint = 'New API /api/status 不可用或缺少 quota_per_unit/usd_exchange_rate；不能折算真钱成本，兑换池必须保持关闭。'
  } else if (!tokenOK) {
    hint = '管理 access token 无法管理子令牌；请确认 NEWAPI_ADMIN_KEY 是系统访问令牌，不是模型 sk Key。'
  }
  return { tokenOK, logOK, logFilterOK, logTimeFilterOK, logSettlementOK, pricingOK, statusOK, logScope, hint }
}
