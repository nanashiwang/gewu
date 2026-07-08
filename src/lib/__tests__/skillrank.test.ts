import { describe, expect, it } from 'vitest'
import {
  publicSkillRankExplanation,
  publicSkillRankBasis,
  skillRankFromAggregates,
  trustedCompatibleEvidenceScore,
} from '@/lib/skillrank'

describe('skillrank — 可信分', () => {
  it('无可信兼容计数时保持旧聚合指标口径', () => {
    const rank = skillRankFromAggregates({
      successRate: 0.8,
      formatSuccessRate: 0.7,
      avgCost: 0.01,
      avgLatencyMs: 1000,
      avgRating: 4,
      lastUpdatedAt: new Date().toISOString(),
    })
    expect(rank).toBeGreaterThan(60)
    expect(rank).toBeLessThan(90)
  })

  it('可信兼容运行数提高可信分，但使用对数饱和避免刷量支配', () => {
    const base = {
      successRate: 0.8,
      formatSuccessRate: 0.7,
      avgCost: 0.01,
      avgLatencyMs: 1000,
      avgRating: 4,
      lastUpdatedAt: new Date().toISOString(),
    }
    const noEvidence = skillRankFromAggregates({ ...base, trustedCompatibleRunCount: 0 })
    const proven = skillRankFromAggregates({ ...base, trustedCompatibleRunCount: 100 })
    expect(proven).toBeGreaterThan(noEvidence)
    expect(proven - noEvidence).toBeLessThanOrEqual(15)
    expect(trustedCompatibleEvidenceScore(0)).toBe(0)
    expect(trustedCompatibleEvidenceScore(100)).toBe(1)
  })

  it('公开排名依据说明可信榜不是下载量/调用量榜', () => {
    const basis = publicSkillRankBasis(
      {
        skillRank: 81.6,
        successRate: 0.9,
        formatSuccessRate: 0.85,
        avgCost: 0.02,
        avgLatencyMs: 1200,
        runCount: 9999,
        downloadCount: 9999,
      },
      {
        trustScore: 88.4,
        reliabilitySummary: { trustedCompatibleRunCount: 9 },
      },
    )

    expect(basis.score).toBe(82)
    expect(basis.factors.passportTrustScore).toBe(88)
    expect(basis.factors.trustedCompatibleRunCount).toBe(9)
    expect(basis.guardrails).toEqual(
      expect.arrayContaining(['不按下载量排序', '普通调用量不直接加分']),
    )
    expect(JSON.stringify(basis)).not.toContain('9999')
  })

  it('公开排名解释给出公式、决策和客户复核提示', () => {
    const explanation = publicSkillRankExplanation(
      { skillRank: 90, successRate: 0.92, formatSuccessRate: 0.88 },
      { trustScore: 86, reliabilitySummary: { trustedCompatibleRunCount: 12 } },
    )

    expect(explanation).toMatchObject({
      decision: 'priority_try',
      formula: {
        baseScore: expect.stringContaining('85%'),
        trustedEvidence: expect.stringContaining('15%'),
      },
      factorWeights: expect.arrayContaining([
        { key: 'evalPassRate', label: '成功/评测通过', weight: 0.35 },
        { key: 'formatSuccessRate', label: '格式成功', weight: 0.1 },
      ]),
      customerHint: expect.stringContaining('看 Passport'),
    })
    expect(explanation.reasons).toEqual(expect.arrayContaining([
      '历史成功率 92%',
      '格式成功率 88%',
      'Passport 86',
      '12 次可信兼容运行',
    ]))
  })
})
