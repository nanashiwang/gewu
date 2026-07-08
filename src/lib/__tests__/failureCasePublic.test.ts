import { describe, expect, it } from 'vitest'
import { buildFailureCaseWhere, isPublicFailureCase, publicFailureCase } from '@/lib/failureCasePublic'

describe('failureCasePublic — 公开失败知识库输出', () => {
  it('公开查询条件在数据库层排除私有 Skill，避免分页数量侧信道', () => {
    expect(buildFailureCaseWhere(new URLSearchParams({ status: 'confirmed', skillId: 'skill-1' }))).toEqual({
      and: [
        { status: { equals: 'confirmed' } },
        {
          or: [
            { skill: { exists: false } },
            {
              and: [
                { 'skill.status': { equals: 'published' } },
                { 'skill.visibility': { equals: 'public' } },
              ],
            },
          ],
        },
        { skill: { equals: 'skill-1' } },
      ],
    })
    expect(buildFailureCaseWhere(new URLSearchParams({ modelVersion: '2026-07-01' }))).toMatchObject({
      and: expect.arrayContaining([{ modelVersions: { contains: '2026-07-01' } }]),
    })
  })

  it('输出脱敏失败画像和证据验签入口，不暴露原始输入输出', () => {
    const row = publicFailureCase({
      id: 'failure-1',
      title: 'JSON 失败',
      profileKey: 'skill|500-2k|json_parse_error',
      errorType: 'json_parse_error',
      modelName: 'qwen-plus',
      primaryModelVersion: '2026-07-01',
      skill: { id: 'skill-1', slug: 'writer', title: 'Writer', status: 'published', visibility: 'public' },
      symptom: '返回非 JSON',
      repairTemplate: '强制输出 JSON，不要解释。',
      verifyTemplate: '连续 3 次 JSON.parse。',
      modelBreakdown: { 'qwen-plus': 3, rawInput: 'secret' },
      modelVersions: ['2026-07-01', '2026-07-02'],
      modelVersionBreakdown: { '2026-07-01': 2, '2026-07-02': 1, rawOutput: 'secret' },
      sourceBreakdown: { benchmark: 2, online: 1 },
      triageStatus: 'attributed',
      rootCauseCategory: 'schema_mismatch',
      triageNotes: 'secret internal note',
      verificationCoverage: { targetRuns: 3, verifiedRuns: 1, beforeSuccessRate: 0.2, afterSuccessRate: 0.8, rawInput: 'secret' },
      evidenceHash: 'a'.repeat(64),
      inputJson: { secret: true },
      outputText: 'raw output',
    }) as any

    expect(row).toMatchObject({
      id: 'failure-1',
      skill: { id: 'skill-1', slug: 'writer', title: 'Writer' },
      evidenceVerifyUrl: '/v1/evidence/verify?targetType=failure_case&targetId=failure-1',
      evidenceVerifyPageUrl: '/verify?targetType=failure_case&targetId=failure-1',
      modelProfileUrl: '/models?modelName=qwen-plus&modelVersion=2026-07-01',
      runLedgerFailureUrl: '/console/runs?success=false&skillId=skill-1&model=qwen-plus&modelVersion=2026-07-01',
      adaptersUrl: '/v1/adapters?modelName=qwen-plus&failureId=failure-1&modelVersion=2026-07-01',
      playbook: {
        customerValue: expect.stringContaining('可复用排障线索'),
        safeForPublic: true,
        profileKey: 'skill|500-2k|json_parse_error',
        triageChecklist: expect.arrayContaining([
          expect.stringContaining('不需要暴露原始输入输出'),
          expect.stringContaining('人工归因状态'),
          expect.stringContaining('私人台账'),
        ]),
        nextActions: expect.arrayContaining([
          expect.objectContaining({ label: '确认是否同类失败' }),
          expect.objectContaining({
            label: '查看模型画像',
            href: '/models?modelName=qwen-plus&modelVersion=2026-07-01',
          }),
          expect.objectContaining({
            label: '用私人台账复现',
            href: '/console/runs?success=false&skillId=skill-1&model=qwen-plus&modelVersion=2026-07-01',
          }),
          expect.objectContaining({
            label: '生成或复用 Adapter',
            href: '/v1/adapters?modelName=qwen-plus&failureId=failure-1&modelVersion=2026-07-01',
          }),
          expect.objectContaining({
            label: '验签证据',
            href: '/verify?targetType=failure_case&targetId=failure-1',
          }),
        ]),
      },
      modelBreakdown: { 'qwen-plus': 3 },
      modelVersions: ['2026-07-01', '2026-07-02'],
      modelVersionBreakdown: { '2026-07-01': 2, '2026-07-02': 1 },
      hasRepairTemplate: true,
      hasVerifyTemplate: true,
      triage: {
        triageStatus: 'attributed',
        rootCauseCategory: 'schema_mismatch',
        hasTriageNotes: true,
        decision: 'create_or_verify_adapter',
        verificationCoverage: { targetRuns: 3, verifiedRuns: 1, beforeSuccessRate: 0.2, afterSuccessRate: 0.8 },
      },
    })
    expect(row.inputJson).toBeUndefined()
    expect(row.outputText).toBeUndefined()
    expect(row.repairTemplate).toBeUndefined()
    expect(row.verifyTemplate).toBeUndefined()
    expect(JSON.stringify(row.triage)).not.toContain('secret')
    expect(JSON.stringify(row.playbook)).not.toContain('强制输出 JSON')
  })

  it('截断公开失败库筛选中的超长字符串，并清洗 source 动态 key', () => {
    const where = buildFailureCaseWhere(new URLSearchParams({
      errorType: 'e'.repeat(100),
      modelName: 'm'.repeat(200),
      source: 'online.$bad',
    })) as any
    expect(where.and).toContainEqual({ errorType: { equals: 'e'.repeat(80) } })
    expect(where.and).toContainEqual({ modelName: { equals: 'm'.repeat(160) } })
    expect(where.and).toContainEqual({ 'sourceBreakdown.online.bad': { greater_than: 0 } })
  })

  it('私有 Skill 关联的失败案例不进入公开失败库，也不暴露 Skill 摘要', () => {
    const row = {
      id: 'failure-private',
      status: 'confirmed',
      skill: { id: 'skill-private', slug: 'secret', title: 'Secret', status: 'published', visibility: 'private' },
    }

    expect(isPublicFailureCase(row)).toBe(false)
    expect(publicFailureCase(row).skill).toBeNull()
  })
})
