import type { NewApiModelPricing } from './newapiAdmin'

export interface UsageDriftResult {
  ok: boolean
  driftCents: number
  absDriftCents: number
  toleranceCents: number
}

export interface UserUsageDriftInput {
  userId: string
  newapiUsageCents: number
  localConsumeCents: number
}

export interface UserUsageDriftResult extends UsageDriftResult, UserUsageDriftInput {
  direction: 'matched' | 'newapi_gt_local' | 'local_gt_newapi'
  action: 'none' | 'manual_backfill_local_or_refund_gateway' | 'manual_refund_local_or_fix_gateway_undercharge'
}

export interface ReconcileDriftReportMeta {
  monthStartISO: string
  generatedAt: string
  usageSource: NewApiUsageSource
}

export interface ModelUsageForMargin {
  modelName: string
  costCents: number
  usedQuota?: number
  tokenPricedQuota?: number
  calls?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface ModelMarginBreakdown extends ModelUsageForMargin {
  marginRate: number
  marginCents: number
}

export interface ModelMarginResult {
  marginCents: number
  byModel: ModelMarginBreakdown[]
  missingModels: string[]
}

export interface ModelTokenCostBreakdown extends Required<ModelUsageForMargin> {
  tokenCostCents: number
  source: 'log_pricing' | 'per_token' | 'per_call'
}

export interface ModelTokenCostResult {
  costCents: number
  byModel: ModelTokenCostBreakdown[]
  missingModels: string[]
}

type Env = Record<string, string | undefined>
export type NewApiUsageSource = 'newapi' | 'local'

export function resolveUsageSource(env: Env = process.env): NewApiUsageSource {
  const raw = (env.NEWAPI_USAGE_SOURCE || 'newapi').trim()
  if (raw === 'newapi' || raw === 'local') return raw
  throw new Error('NEWAPI_USAGE_SOURCE 必须是 newapi 或 local，禁止静默回退到默认口径')
}

export function resolveReconcileMarginRate(
  env: Env = process.env,
  opts: { requirePositive?: boolean } = {},
): number {
  const raw = env.NEWAPI_MARGIN_RATE?.trim()
  if (!raw) {
    if (opts.requirePositive) throw new Error('NEWAPI_MARGIN_RATE 写回毛利前必须配置为 0-1 之间的正数')
    return 0
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1 || (opts.requirePositive && n <= 0)) {
    throw new Error('NEWAPI_MARGIN_RATE 必须是 0-1 之间的数字；--apply 写回毛利时必须大于 0')
  }
  return n
}

export function resolveReconcileModelMarginRates(
  env: Env = process.env,
  opts: { requireConfigured?: boolean } = {},
): Map<string, number> {
  const raw = env.NEWAPI_MODEL_MARGIN_RATES?.trim()
  if (!raw) {
    if (opts.requireConfigured) {
      throw new Error('NEWAPI_MODEL_MARGIN_RATES 写回真钱毛利前必须按模型配置，如 deepseek-chat=0.25,qwen-plus=0.18')
    }
    return new Map()
  }
  const rates = new Map<string, number>()
  for (const part of raw.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=')
    if (i <= 0 || i === part.length - 1) {
      throw new Error('NEWAPI_MODEL_MARGIN_RATES 格式必须是 model=rate 逗号分隔')
    }
    const modelName = part.slice(0, i).trim()
    const rate = Number(part.slice(i + 1).trim())
    if (!modelName) throw new Error('NEWAPI_MODEL_MARGIN_RATES 包含空模型名')
    if (rates.has(modelName)) throw new Error(`NEWAPI_MODEL_MARGIN_RATES 重复配置模型 ${modelName}`)
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error(`NEWAPI_MODEL_MARGIN_RATES 中 ${modelName} 必须是 0-1 之间的数字`)
    }
    rates.set(modelName, rate)
  }
  if (opts.requireConfigured && rates.size === 0) {
    throw new Error('NEWAPI_MODEL_MARGIN_RATES 写回真钱毛利前必须至少配置一个模型')
  }
  return rates
}

export function mergeModelUsageRows(
  rows: ModelUsageForMargin[],
  opts: { quotaPerCredit?: number } = {},
): Required<ModelUsageForMargin>[] {
  const merged = new Map<string, Required<ModelUsageForMargin>>()
  for (const row of rows) {
    const modelName = row.modelName.trim()
    if (!modelName) continue
    const prev = merged.get(modelName) || {
      modelName,
      costCents: 0,
      usedQuota: 0,
      tokenPricedQuota: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    prev.costCents += Math.max(0, Math.round(row.costCents || 0))
    prev.usedQuota += Math.max(0, Math.round(row.usedQuota || 0))
    prev.tokenPricedQuota += Math.max(0, Math.round(row.tokenPricedQuota || 0))
    prev.calls += Math.max(0, Math.round(row.calls || 0))
    prev.inputTokens += Math.max(0, Math.round(row.inputTokens || 0))
    prev.outputTokens += Math.max(0, Math.round(row.outputTokens || 0))
    prev.cacheReadTokens += Math.max(0, Math.round(row.cacheReadTokens || 0))
    prev.cacheCreationTokens += Math.max(0, Math.round(row.cacheCreationTokens || 0))
    merged.set(modelName, prev)
  }
  const quotaPerCredit = opts.quotaPerCredit
  return Array.from(merged.values())
    .map((row) => ({
      ...row,
      costCents:
        Number.isFinite(quotaPerCredit) && quotaPerCredit && quotaPerCredit > 0 && row.usedQuota > 0
          ? Math.round(row.usedQuota / quotaPerCredit)
          : row.costCents,
    }))
    .sort((a, b) => b.costCents - a.costCents || a.modelName.localeCompare(b.modelName))
}

export function calculateTokenPricedCostCents(
  rows: ModelUsageForMargin[],
  pricing: NewApiModelPricing[],
  opts: { requireAllModels?: boolean; quotaPerUnit?: number; usdToCny?: number } = {},
): ModelTokenCostResult {
  const pricingMap = new Map(pricing.map((p) => [p.modelName, p]))
  const merged = mergeModelUsageRows(rows)
  const missingModels = Array.from(
    new Set(merged.filter((r) => r.tokenPricedQuota <= 0).map((r) => r.modelName).filter((modelName) => !pricingMap.has(modelName))),
  ).sort()
  if (opts.requireAllModels && missingModels.length > 0) {
    throw new Error(`New API /api/pricing 缺少模型价格：${missingModels.join(',')}`)
  }
  const quotaPerUnit = opts.quotaPerUnit || 500000
  const usdToCny = opts.usdToCny || 7
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error('quota_per_unit 必须是正数')
  if (!Number.isFinite(usdToCny) || usdToCny <= 0) throw new Error('usd_exchange_rate 必须是正数')

  const byModel = merged.map((row) => {
    if (row.tokenPricedQuota > 0) {
      const usd = row.tokenPricedQuota / quotaPerUnit
      return { ...row, tokenCostCents: Math.max(0, Math.round(usd * usdToCny * 100)), source: 'log_pricing' as const }
    }
    const p = pricingMap.get(row.modelName)
    if (!p) return { ...row, tokenCostCents: 0, source: 'per_token' as const }
    if (p.quotaType === 1) {
      const usd = (row.calls || 0) * p.modelPrice * p.groupRatio
      return { ...row, tokenCostCents: Math.max(0, Math.round(usd * usdToCny * 100)), source: 'per_call' as const }
    }
    if (!Number.isFinite(p.modelRatio) || p.modelRatio <= 0) {
      if (opts.requireAllModels) throw new Error(`New API 模型 ${row.modelName} 缺少有效 model_ratio`)
      return { ...row, tokenCostCents: 0, source: 'per_token' as const }
    }
    if (!Number.isFinite(p.completionRatio) || p.completionRatio < 0) {
      if (opts.requireAllModels) throw new Error(`New API 模型 ${row.modelName} 缺少有效 completion_ratio`)
      return { ...row, tokenCostCents: 0, source: 'per_token' as const }
    }
    if ((row.cacheReadTokens || 0) > 0 && !p.supportsCacheRead) {
      if (opts.requireAllModels) throw new Error(`New API 模型 ${row.modelName} 日志含 cache 命中 token，但 /api/pricing 未标记 supports_cache_read`)
    }
    if ((row.cacheCreationTokens || 0) > 0 && !p.supportsCacheCreation) {
      if (opts.requireAllModels) throw new Error(`New API 模型 ${row.modelName} 日志含 cache 创建 token，但 /api/pricing 未标记 supports_cache_creation`)
    }
    const unitUsd = (p.modelRatio * p.groupRatio) / quotaPerUnit
    const inputUsd = (row.inputTokens || 0) * unitUsd
    const outputUsd = (row.outputTokens || 0) * unitUsd * p.completionRatio
    const cacheReadUsd = (row.cacheReadTokens || 0) * unitUsd * (p.supportsCacheRead ? p.cacheRatio : 0)
    const cacheCreationUsd =
      (row.cacheCreationTokens || 0) * unitUsd * (p.supportsCacheCreation ? p.cacheCreationRatio : 0)
    return {
      ...row,
      tokenCostCents: Math.max(0, Math.round((inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd) * usdToCny * 100)),
      source: 'per_token' as const,
    }
  })
  return {
    byModel,
    missingModels,
    costCents: byModel.reduce((sum, row) => sum + row.tokenCostCents, 0),
  }
}

export function calculateModelMarginCents(
  rows: ModelUsageForMargin[],
  rates: Map<string, number>,
  opts: { requireAllModels?: boolean; missingModelCalls?: number } = {},
): ModelMarginResult {
  const missingModelCalls = Math.max(0, Math.round(opts.missingModelCalls || 0))
  if (opts.requireAllModels && missingModelCalls > 0) {
    throw new Error(`New API /api/log 有 ${missingModelCalls} 条消费记录缺少模型字段，不能按模型倍率计算真钱毛利`)
  }
  const merged = mergeModelUsageRows(rows)
  const missingModels = Array.from(new Set(merged.map((r) => r.modelName).filter((modelName) => !rates.has(modelName)))).sort()
  if (opts.requireAllModels && missingModels.length > 0) {
    throw new Error(`NEWAPI_MODEL_MARGIN_RATES 缺少模型毛利率：${missingModels.join(',')}`)
  }
  const byModel = merged.map((row) => {
    const marginRate = rates.get(row.modelName) ?? 0
    const marginCents = Math.max(0, Math.round(row.costCents * marginRate))
    return { ...row, marginRate, marginCents }
  })
  return {
    byModel,
    missingModels,
    marginCents: byModel.reduce((sum, row) => sum + row.marginCents, 0),
  }
}

export function resolveReconcileToleranceCents(env: Env = process.env): number | undefined {
  const raw = env.NEWAPI_RECONCILE_TOLERANCE_CENTS?.trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('NEWAPI_RECONCILE_TOLERANCE_CENTS 必须是非负数字，禁止非法漂移容忍值静默回退')
  }
  return Math.floor(n)
}

export function usageDriftToleranceCents(
  newapiUsageCents: number,
  localConsumeCents: number,
  explicitTolerance?: number,
): number {
  if (Number.isFinite(explicitTolerance) && explicitTolerance !== undefined && explicitTolerance >= 0) {
    return Math.floor(explicitTolerance)
  }
  // rounding and tiny calls need a cent floor; larger volume should stay within 5%.
  return Math.max(2, Math.ceil(Math.max(newapiUsageCents || 0, localConsumeCents || 0) * 0.05))
}

export function compareUsageDrift(
  newapiUsageCents: number,
  localConsumeCents: number,
  explicitTolerance?: number,
): UsageDriftResult {
  const safeNewapi = Math.max(0, Math.round(newapiUsageCents || 0))
  const safeLocal = Math.max(0, Math.round(localConsumeCents || 0))
  const toleranceCents = usageDriftToleranceCents(safeNewapi, safeLocal, explicitTolerance)
  const driftCents = safeNewapi - safeLocal
  const absDriftCents = Math.abs(driftCents)
  return {
    ok: absDriftCents <= toleranceCents,
    driftCents,
    absDriftCents,
    toleranceCents,
  }
}

export function buildUserUsageDriftReport(
  rows: UserUsageDriftInput[],
  explicitTolerance?: number,
): UserUsageDriftResult[] {
  return rows
    .map((row) => {
      const drift = compareUsageDrift(row.newapiUsageCents, row.localConsumeCents, explicitTolerance)
      const direction: UserUsageDriftResult['direction'] =
        drift.driftCents > 0 ? 'newapi_gt_local' : drift.driftCents < 0 ? 'local_gt_newapi' : 'matched'
      const action: UserUsageDriftResult['action'] = drift.ok
        ? 'none'
        : drift.driftCents > 0
          ? 'manual_backfill_local_or_refund_gateway'
          : 'manual_refund_local_or_fix_gateway_undercharge'
      return {
        ...row,
        ...drift,
        direction,
        action,
      }
    })
    .sort((a, b) => b.absDriftCents - a.absDriftCents)
}

export function formatUserUsageDriftJsonl(
  rows: UserUsageDriftResult[],
  meta: ReconcileDriftReportMeta,
): string {
  return rows
    .map((row) =>
      JSON.stringify({
        schema: 'gewu.newapi.user_drift.v1',
        ...meta,
        userId: row.userId,
        newapiUsageCents: row.newapiUsageCents,
        localConsumeCents: row.localConsumeCents,
        driftCents: row.driftCents,
        absDriftCents: row.absDriftCents,
        toleranceCents: row.toleranceCents,
        direction: row.direction,
        action: row.action,
      }),
    )
    .join('\n')
}
