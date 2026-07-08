import { describe, expect, it } from 'vitest'
import { mergeReverifyCoverage } from '@/lib/reverifyWorker'

describe('reverifyWorker — 自动复验结果回写', () => {
  it('把复验成功率和格式率合并进已有覆盖数据', () => {
    const coverage = mergeReverifyCoverage(
      { targetRuns: 3, verifiedRuns: 1, afterSuccessRate: 1, formatRateAfter: 1 },
      {
        attempted: 2,
        succeeded: 1,
        formatValid: 1,
        outcomes: [
          { sourceRunId: 'run-1', newRunId: 'new-1', ok: true, formatValid: true },
          { sourceRunId: 'run-2', newRunId: 'new-2', ok: false, formatValid: false, errorCode: 'FORMAT_INVALID' },
        ],
      },
      { now: '2026-07-08T00:00:00.000Z' },
    )

    expect(coverage).toMatchObject({
      targetRuns: 3,
      verifiedRuns: 3,
      afterSuccessRate: 2 / 3,
      formatRateAfter: 2 / 3,
      lastReverifiedAt: '2026-07-08T00:00:00.000Z',
    })
    expect(coverage.lastReverifyOutcomes).toHaveLength(2)
  })

  it('保留 job 摘要但不写入用户输入输出原文', () => {
    const coverage = mergeReverifyCoverage(
      {},
      {
        attempted: 1,
        succeeded: 1,
        formatValid: 1,
        outcomes: [{ sourceRunId: 'run-1', newRunId: 'new-1', ok: true, formatValid: true }],
      },
      {
        now: '2026-07-08T00:00:00.000Z',
        job: {
          failureCaseId: 'failure-1',
          userId: 'user-1',
          candidateRunIds: ['run-1'],
          adapterIds: ['adapter-1'],
          reason: 'manual',
          enqueuedAt: '2026-07-08T00:00:00.000Z',
        },
      },
    )

    expect(coverage.lastReverifyJob).toEqual({
      failureCaseId: 'failure-1',
      userId: 'user-1',
      candidateRunIds: ['run-1'],
      adapterIds: ['adapter-1'],
      reason: 'manual',
      enqueuedAt: '2026-07-08T00:00:00.000Z',
    })
    expect(JSON.stringify(coverage)).not.toContain('inputJson')
    expect(JSON.stringify(coverage)).not.toContain('outputText')
  })
})
