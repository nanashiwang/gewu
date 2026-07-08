import { describe, expect, it } from 'vitest'
import { FailureCases } from '@/collections/FailureCases'
import { buildFailureCaseData } from '@/lib/failureCase'
import type { FailureKnowledgeGroup } from '@/lib/failureKnowledge'

describe('failureCase — 失败知识一等资产', () => {
  it('从聚合失败组生成脱敏 FailureCase', () => {
    const data = buildFailureCaseData({
      profileKey: 'skill-1|100-500|json_invalid',
      errorType: 'json_invalid',
      modelName: 'qwen-plus',
      primaryModelVersion: '2026-07-01',
      primaryInputBucket: '100-500',
      count: 3,
      skillCount: 2,
      sampleSkills: [{ id: 'skill-1', title: 'JSON 生成' }],
      inputBuckets: ['100-500'],
      outputBuckets: ['0-100'],
      modelBreakdown: { 'qwen-plus': 3 },
      modelVersions: ['2026-07-01'],
      modelVersionBreakdown: { '2026-07-01': 3 },
      sourceBreakdown: { online: 2, benchmark: 1 },
      meta: {
        label: '非 JSON 输出',
        layer: '模型能力',
        symptom: '返回自然语言',
        likelyCause: 'JSON 约束不足',
        publicFixHint: '加强 JSON-only 指令',
        repairTemplate: '只输出 JSON',
        verifyTemplate: '连续 3 次 JSON.parse',
      },
    } satisfies FailureKnowledgeGroup, new Date('2026-07-08T00:00:00.000Z'))

    expect(data).toMatchObject({
      title: '非 JSON 输出 · JSON 生成 · qwen-plus',
      profileKey: 'skill-1|100-500|json_invalid',
      errorType: 'json_invalid',
      modelName: 'qwen-plus',
      primaryModelVersion: '2026-07-01',
      primaryInputBucket: '100-500',
      modelVersions: ['2026-07-01'],
      modelVersionBreakdown: { '2026-07-01': 3 },
      skill: 'skill-1',
      occurrenceCount: 3,
      affectedSkillCount: 2,
      status: 'confirmed',
      lastObservedAt: '2026-07-08T00:00:00.000Z',
    })
    expect(data.evidenceHash).toHaveLength(64)
  })

  it('collection hook 记录人工归因时间和归因人', () => {
    const beforeChange = FailureCases.hooks?.beforeChange?.[0] as any
    const data = beforeChange({
      data: { triageStatus: 'attributed', rootCauseCategory: 'model_drift' },
      originalDoc: { triageStatus: 'pending' },
      req: { user: { id: 'reviewer-1', role: 'reviewer' } },
    })

    expect(data.triagedAt).toBeTruthy()
    expect(data.triagedBy).toBe('reviewer-1')
  })
})
