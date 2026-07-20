import { describe, expect, it } from 'vitest'
import { buildModelProfileWhere, isPublicModelProfile, publicModelProfile } from '@/lib/modelProfilePublic'

describe('modelProfilePublic — 公开模型画像输出', () => {
  it('构造公开模型画像筛选条件', () => {
    const params = new URLSearchParams({
      modelName: 'gpt-4.1-mini',
      modelVersion: '2026-07-01',
      provider: 'openai',
      status: 'verified',
    })
    expect(buildModelProfileWhere(params)).toEqual({
      and: [
        { profileStatus: { equals: 'verified' } },
        { modelName: { equals: 'gpt-4.1-mini' } },
        { modelVersion: { equals: '2026-07-01' } },
        { provider: { equals: 'openai' } },
      ],
    })
  })

  it('默认不公开 deprecated 或零样本模型画像', () => {
    expect(buildModelProfileWhere(new URLSearchParams({ status: 'deprecated' }))).toEqual({
      and: [{ profileStatus: { in: ['observed', 'verified', 'stale'] } }],
    })
    expect(isPublicModelProfile({ profileStatus: 'verified', capabilities: { observedSamples: 1 } })).toBe(true)
    expect(isPublicModelProfile({ profileStatus: 'deprecated', capabilities: { observedSamples: 10 } })).toBe(false)
    expect(isPublicModelProfile({ profileStatus: 'observed', capabilities: { observedSamples: 0, effectiveSamples: 0 } })).toBe(false)
    expect(JSON.stringify(buildModelProfileWhere(new URLSearchParams()))).not.toContain('capabilities.')
  })

  it('截断公开模型画像筛选中的超长字符串', () => {
    const where = buildModelProfileWhere(new URLSearchParams({
      modelName: 'x'.repeat(200),
      modelVersion: 'v'.repeat(200),
      provider: 'p'.repeat(120),
    })) as any
    expect(where.and).toContainEqual({ modelName: { equals: 'x'.repeat(160) } })
    expect(where.and).toContainEqual({ modelVersion: { equals: 'v'.repeat(160) } })
    expect(where.and).toContainEqual({ provider: { equals: 'p'.repeat(80) } })
  })

  it('输出漂移、有效样本和来源权重，不暴露平台收益字段', () => {
    const row = publicModelProfile({
      id: 'profile-1',
      provider: 'openai',
      modelName: 'gpt-4.1-mini',
      modelVersion: '2026-07-01',
      profileStatus: 'verified',
      inputPrice: 1,
      outputPrice: 2,
      platformPayAllowed: true,
      capabilities: {
        observedSamples: 10,
        effectiveSamples: 7.5,
        sourceSummary: [{ source: 'benchmark', count: 3, weight: 1 }],
        inputBucketSummary: [{ inputBucket: '8k+', count: 2, effectiveSamples: 1.5, successRate: 0.5, formatRate: 1, rawInput: 'secret' }],
        taskProfileSummary: [{ profileKey: '8k+|schema_error|2026-07-01', inputBucket: '8k+', errorType: 'schema_error', modelVersion: '2026-07-01', count: 2, effectiveSamples: 1.5, successRate: 0, formatRate: 0, rawOutput: 'secret' }],
        skillProfileSummary: [{ profileKey: 'skill-1|8k+|schema_error|2026-07-01', skillId: 'skill-1', skillSlug: 'writer', skillTitle: 'Writer', inputBucket: '8k+', errorType: 'schema_error', modelVersion: '2026-07-01', count: 2, effectiveSamples: 1.5, successRate: 0, formatRate: 0, rawOutput: 'secret' }],
        platformRevenue: 99,
      },
      driftHistory: [{ successRate: 0.9, rawInput: 'secret' }],
      regressionAlerts: [{ reason: 'ok', outputText: 'secret' }],
    }) as any
    expect(row).toMatchObject({
      provider: 'openai',
      modelName: 'gpt-4.1-mini',
      modelVersion: '2026-07-01',
      capabilities: {
        observedSamples: 10,
        effectiveSamples: 7.5,
        inputBucketSummary: [{ inputBucket: '8k+', count: 2, effectiveSamples: 1.5, successRate: 0.5, formatRate: 1 }],
        taskProfileSummary: [{ profileKey: '8k+|schema_error|2026-07-01', inputBucket: '8k+', errorType: 'schema_error', modelVersion: '2026-07-01', count: 2, effectiveSamples: 1.5, successRate: 0, formatRate: 0 }],
        skillProfileSummary: [{ profileKey: 'skill-1|8k+|schema_error|2026-07-01', skillId: 'skill-1', skillSlug: 'writer', skillTitle: 'Writer', inputBucket: '8k+', errorType: 'schema_error', modelVersion: '2026-07-01', count: 2, effectiveSamples: 1.5, successRate: 0, formatRate: 0 }],
      },
      driftHistory: [{ successRate: 0.9 }],
      failuresUrl: '/failures?modelName=gpt-4.1-mini&modelVersion=2026-07-01',
      adaptersUrl: '/v1/adapters?modelName=gpt-4.1-mini&modelVersion=2026-07-01',
      playbook: {
        customerValue: expect.stringContaining('可执行判断'),
        decision: 'review',
        adoptionChecklist: expect.arrayContaining([
          expect.stringContaining('modelName + modelVersion'),
          expect.stringContaining('inputBucket'),
          expect.stringContaining('taskProfile'),
          expect.stringContaining('私人台账'),
        ]),
        nextActions: expect.arrayContaining([
          expect.objectContaining({ label: '确认模型版本' }),
          expect.objectContaining({ label: '看有效样本和来源' }),
          expect.objectContaining({ label: '处理漂移/回归' }),
          expect.objectContaining({
            label: '用私人台账复验',
            href: '/console/runs?model=gpt-4.1-mini&modelVersion=2026-07-01',
          }),
          expect.objectContaining({
            label: '查失败库/Adapter',
            href: '/failures?modelName=gpt-4.1-mini&modelVersion=2026-07-01',
          }),
        ]),
      },
    })
    expect(row.inputPrice).toBeUndefined()
    expect(row.outputPrice).toBeUndefined()
    expect(row.platformPayAllowed).toBeUndefined()
    expect(row.capabilities.platformRevenue).toBeUndefined()
    expect(JSON.stringify(row.capabilities.inputBucketSummary)).not.toContain('secret')
    expect(JSON.stringify(row.capabilities.taskProfileSummary)).not.toContain('secret')
    expect(JSON.stringify(row.capabilities.skillProfileSummary)).not.toContain('secret')
    expect(row.regressionAlerts).toEqual([{ reason: 'ok' }])
  })

  it('模型画像 playbook 根据稳定性给出 use/review/avoid 动作', () => {
    expect(
      (publicModelProfile({
        id: 'stable',
        modelName: 'qwen-plus',
        profileStatus: 'verified',
        capabilities: { effectiveSamples: 8 },
        driftSummary: { status: 'stable' },
      }) as any).playbook.decision,
    ).toBe('use')
    expect(
      (publicModelProfile({
        id: 'warn',
        modelName: 'qwen-plus',
        profileStatus: 'stale',
        capabilities: { effectiveSamples: 8 },
        regressionAlerts: [{ severity: 'warning' }],
      }) as any).playbook.decision,
    ).toBe('review')
    expect(
      (publicModelProfile({
        id: 'critical',
        modelName: 'qwen-plus',
        profileStatus: 'verified',
        capabilities: { effectiveSamples: 8 },
        regressionAlerts: [{ severity: 'critical' }],
      }) as any).playbook.decision,
    ).toBe('avoid')
  })
})
