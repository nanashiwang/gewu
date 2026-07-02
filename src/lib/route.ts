import type { RouteMode } from './constants'
import { MODEL_PRICES } from './constants'

export interface RoutePolicy {
  default?: string
  strategies?: Record<string, string[]>
  // 数据回写(#15 护城河第1层)：由真实兼容回流重算，优先于作者手填 strategies；不覆盖 strategies 本身
  dataDriven?: {
    cheap?: string[]
    fast?: string[]
    quality?: string[]
    recomputedAt?: string
  }
}
export interface RecommendedModels {
  cloud?: string[]
  local?: string[]
}

// 成本代理：每 1k token 进+出价之和（越小越省），仅用于同 Skill 内模型省钱排序
export function modelCostProxy(model: string): number {
  const p = MODEL_PRICES[model] || MODEL_PRICES.default
  return (p?.in || 0) + (p?.out || 0)
}

export interface RouteRankInput {
  modelName: string
  successRate: number
  avgLatencyMs: number
  formatRate: number
  lowSample: boolean
}

// 由逐模型兼容聚合排出数据驱动路由：只取"够样本 + 成功率达标"的可用模型，再按 省/快/质 三维排序。
export function rankDataDrivenRoute(
  models: RouteRankInput[],
  minSuccess = 0.7,
): { cheap: string[]; fast: string[]; quality: string[] } {
  const working = models.filter((m) => !m.lowSample && m.successRate >= minSuccess)
  const cheap = [...working]
    .sort(
      (a, b) => modelCostProxy(a.modelName) - modelCostProxy(b.modelName) || b.successRate - a.successRate,
    )
    .map((m) => m.modelName)
  const fast = [...working].sort((a, b) => a.avgLatencyMs - b.avgLatencyMs).map((m) => m.modelName)
  const quality = [...working]
    .sort(
      (a, b) =>
        b.successRate * 0.6 + b.formatRate * 0.4 - (a.successRate * 0.6 + a.formatRate * 0.4),
    )
    .map((m) => m.modelName)
  return { cheap, fast, quality }
}

/**
 * 任务级路由：依据路由策略 + 路由模式选出主模型与 fallback 列表。
 * 优先级：dataDriven[mode]（真实回流）→ strategies[mode]（作者手填）→ recommended.cloud → 全局默认模型。
 */
export function selectModel(
  routePolicy: RoutePolicy | null | undefined,
  recommended: RecommendedModels | null | undefined,
  mode: RouteMode | undefined,
  fallbackDefault: string,
): { model: string; fallbacks: string[]; mode: RouteMode } {
  const resolvedMode: RouteMode = mode || (routePolicy?.default as RouteMode) || 'balanced'
  const strategies = routePolicy?.strategies || {}
  const dataDriven = (routePolicy?.dataDriven || {}) as Record<string, string[]>
  const cloud = recommended?.cloud || []
  const dd = dataDriven[resolvedMode] || []

  const primary = dd[0] || strategies[resolvedMode]?.[0] || cloud[0] || fallbackDefault

  const fallbacks = [...dd, ...(strategies.fallback || []), ...cloud, fallbackDefault].filter(
    (m, i, arr) => m && m !== primary && arr.indexOf(m) === i,
  )

  return { model: primary, fallbacks, mode: resolvedMode }
}
