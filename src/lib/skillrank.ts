// 可信分加权计算（沿用 skillRank 字段，前台展示为“可信分”）

export interface SkillMetricsInput {
  evalPassRate?: number // 评测通过率 0..1
  stability?: number // 稳定性 0..1
  costAdvantage?: number // 成本优势 0..1（越省越高）
  latencyScore?: number // 延迟表现 0..1（越快越高）
  formatSuccessRate?: number // 输出格式成功率 0..1
  maintenance?: number // 维护活跃度 0..1
  userFeedback?: number // 用户反馈 0..1
}

const clamp01 = (x?: number) => Math.max(0, Math.min(1, x ?? 0))

export function computeSkillRank(m: SkillMetricsInput): number {
  const score =
    clamp01(m.evalPassRate) * 0.35 +
    clamp01(m.stability) * 0.15 +
    clamp01(m.costAdvantage) * 0.15 +
    clamp01(m.latencyScore) * 0.1 +
    clamp01(m.formatSuccessRate) * 0.1 +
    clamp01(m.maintenance) * 0.1 +
    clamp01(m.userFeedback) * 0.05
  return Math.round(score * 1000) / 10 // → 0..100，一位小数
}

/** 由 Skill 聚合指标推导可信分（缺评测集时用稳定性近似评测通过率） */
export function skillRankFromAggregates(s: {
  successRate?: number | null
  avgCost?: number | null
  avgLatencyMs?: number | null
  formatSuccessRate?: number | null
  avgRating?: number | null
  trustedCompatibleRunCount?: number | null
  lastUpdatedAt?: string | Date | null
}): number {
  const costAdvantage = s.avgCost != null ? 1 / (1 + (s.avgCost as number) * 50) : 0.5
  const latencyScore =
    s.avgLatencyMs != null ? 1 / (1 + (s.avgLatencyMs as number) / 4000) : 0.5
  const base = computeSkillRank({
    evalPassRate: s.successRate ?? 0,
    stability: s.successRate ?? 0,
    costAdvantage,
    latencyScore,
    formatSuccessRate: s.formatSuccessRate ?? 0,
    maintenance: recencyScore(s.lastUpdatedAt),
    userFeedback: (s.avgRating ?? 0) / 5,
  })
  if (s.trustedCompatibleRunCount == null) return base
  const trustedEvidenceScore = trustedCompatibleEvidenceScore(s.trustedCompatibleRunCount)
  return Math.round((base * 0.85 + trustedEvidenceScore * 15) * 10) / 10
}

function recencyScore(d?: string | Date | null): number {
  if (!d) return 0.3
  const days = (Date.now() - new Date(d).getTime()) / 86_400_000
  if (days <= 7) return 1
  if (days <= 30) return 0.7
  if (days <= 90) return 0.4
  return 0.2
}

export function trustedCompatibleEvidenceScore(count?: number | null): number {
  const n = Math.max(0, Number(count || 0))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(1, Math.log10(1 + n) / Math.log10(101))
}

export function publicSkillRankBasis(skill: any, passport?: any) {
  const trustedCompatibleRunCount = Number(
    passport?.reliabilitySummary?.trustedCompatibleRunCount ??
      passport?.evidenceSummary?.trustedCompatibleRunCount ??
      skill?.trustedCompatibleRunCount ??
      0,
  )
  const safeTrustedCount = Number.isFinite(trustedCompatibleRunCount)
    ? Math.max(0, Math.floor(trustedCompatibleRunCount))
    : 0
  return {
    label: '可信发现排序',
    score: Math.round(Number(skill?.skillRank || 0)),
    factors: {
      successRate: skill?.successRate ?? null,
      formatSuccessRate: skill?.formatSuccessRate ?? null,
      avgCost: skill?.avgCost ?? null,
      avgLatencyMs: skill?.avgLatencyMs ?? null,
      passportTrustScore:
        typeof passport?.trustScore === 'number'
          ? Math.round(passport.trustScore)
          : null,
      trustedCompatibleRunCount: safeTrustedCount,
      trustedCompatibleEvidenceWeight:
        Math.round(trustedCompatibleEvidenceScore(safeTrustedCount) * 100) / 100,
    },
    guardrails: [
      '不按下载量排序',
      '普通调用量不直接加分',
      '可信兼容样本采用对数饱和，避免刷量支配',
      '样本少的 Skill 只建议试用，不建议直接采购',
    ],
  }
}

export function publicSkillRankExplanation(skill: any, passport?: any) {
  const basis = publicSkillRankBasis(skill, passport)
  const trustScore = basis.factors.passportTrustScore
  const trustedRuns = basis.factors.trustedCompatibleRunCount
  const successRate = Number(basis.factors.successRate ?? 0)
  const formatRate = Number(basis.factors.formatSuccessRate ?? 0)
  const decision =
    trustScore != null && trustScore >= 80 && trustedRuns >= 5
      ? 'priority_try'
      : trustedRuns <= 0 || trustScore == null
        ? 'verify_first'
        : 'small_trial'
  return {
    ...basis,
    formula: {
      baseScore: '成功率/稳定性/成本/延迟/格式率/维护/用户反馈合成 85%',
      trustedEvidence: '可信兼容运行数按对数饱和补强 15%',
      saturation: '可信兼容样本 100 条左右接近满权重，继续刷量收益很低',
    },
    factorWeights: [
      { key: 'evalPassRate', label: '成功/评测通过', weight: 0.35 },
      { key: 'stability', label: '稳定性', weight: 0.15 },
      { key: 'costAdvantage', label: '成本优势', weight: 0.15 },
      { key: 'latencyScore', label: '延迟表现', weight: 0.1 },
      { key: 'formatSuccessRate', label: '格式成功', weight: 0.1 },
      { key: 'maintenance', label: '维护活跃', weight: 0.1 },
      { key: 'userFeedback', label: '用户反馈', weight: 0.05 },
    ],
    decision,
    reasons: [
      successRate > 0 ? `历史成功率 ${Math.round(successRate * 100)}%` : '成功率样本不足',
      formatRate > 0 ? `格式成功率 ${Math.round(formatRate * 100)}%` : '格式率样本不足',
      trustScore != null ? `Passport ${trustScore}` : 'Passport 待生成',
      `${trustedRuns} 次可信兼容运行`,
    ],
    customerHint:
      decision === 'priority_try'
        ? '证据较强，可优先试跑；采购前仍建议看 Passport/证书并用自己的输入复验。'
        : decision === 'small_trial'
          ? '已有部分证据，适合小流量试用后再决定是否采用。'
          : '证据不足，先验签 Passport/证书并用默认输入或私人台账复验。',
  }
}
