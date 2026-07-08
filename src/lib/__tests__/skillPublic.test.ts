import { describe, expect, it } from 'vitest'
import { publicSkillSummary } from '@/lib/skillPublic'

describe('skillPublic — 公开 Skill 列表输出', () => {
  it('输出 onboarding 所需摘要和 Passport/证书入口，不暴露 prompt', () => {
    const row = publicSkillSummary(
      {
        id: 'skill-1',
        slug: 'writer',
        title: 'Writer',
        description: 'desc',
        category: { id: 'cat-1', slug: 'writing', name: '写作', icon: '✍' },
        author: { id: 'u1', username: 'alice' },
        status: 'published',
        visibility: 'public',
        isEssential: true,
        essentialReason: '第一跑推荐理由',
        skillRank: 87.4,
        runCount: 999,
        systemPrompt: 'secret',
        promptTemplate: 'secret',
      },
      {
        id: 'passport-1',
        status: 'current',
        skillClass: 'verified',
        trustScore: 91.6,
        reliabilitySummary: { trustedCompatibleRunCount: 7 },
        evidenceHash: 'hash-1',
        lastVerifiedAt: '2026-07-08T00:00:00.000Z',
      },
    ) as any

    expect(row).toMatchObject({
      slug: 'writer',
      isEssential: true,
      essentialReason: '第一跑推荐理由',
      skillRank: 87,
      rankBasis: {
        label: '可信发现排序',
        score: 87,
        factors: {
          passportTrustScore: 92,
          trustedCompatibleRunCount: 7,
        },
        guardrails: expect.arrayContaining([
          '不按下载量排序',
          '普通调用量不直接加分',
          '可信兼容样本采用对数饱和，避免刷量支配',
        ]),
      },
      rankExplanation: {
        decision: 'priority_try',
        formula: {
          baseScore: expect.stringContaining('85%'),
          trustedEvidence: expect.stringContaining('15%'),
        },
        customerHint: expect.stringContaining('Passport'),
        reasons: expect.arrayContaining([
          'Passport 92',
          '7 次可信兼容运行',
        ]),
      },
      trustedCompatibleRunCount: 7,
      passport: {
        status: 'current',
        skillClass: 'verified',
        trustScore: 92,
        trustedCompatibleRunCount: 7,
        evidenceHash: 'hash-1',
        evidenceVerifyUrl: '/v1/evidence/verify?targetType=skill_passport&targetId=passport-1',
        evidenceVerifyPageUrl: '/verify?targetType=skill_passport&targetId=passport-1',
        url: '/v1/skills/writer/passport',
      },
      passportUrl: '/v1/skills/writer/passport',
      certificateUrl: '/v1/skills/writer/certificate',
      certificateVerifyPageUrl: '/verify?certificateUrl=%2Fv1%2Fskills%2Fwriter%2Fcertificate',
      evidenceVerifyUrl: '/v1/evidence/verify?targetType=skill_passport&targetId=passport-1',
      evidenceVerifyPageUrl: '/verify?targetType=skill_passport&targetId=passport-1',
      detailUrl: '/skills/writer',
      runUrl: '/skills/writer/run',
      runLedgerUrl: '/console/runs?skillId=skill-1',
      starterPlaybook: {
        customerValue: expect.stringContaining('快速尝到甜头'),
        decision: 'start_here',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ label: '先跑必备 Skill', href: '/skills/writer' }),
          expect.objectContaining({ label: '看 Passport', href: '/v1/skills/writer/passport' }),
          expect.objectContaining({ label: '默认输入试跑', href: '/skills/writer/run' }),
          expect.objectContaining({ label: '回台账重跑', href: '/console/runs?skillId=skill-1' }),
        ]),
      },
    })
    expect(row.systemPrompt).toBeUndefined()
    expect(row.promptTemplate).toBeUndefined()
    expect(row.runCount).toBeUndefined()
    expect(JSON.stringify(row.starterPlaybook)).not.toContain('secret')
  })

  it('非必备且缺少 Passport 时提示先复核', () => {
    const row = publicSkillSummary({ id: 'skill-2', slug: 'draft', isEssential: false }) as any

    expect(row.starterPlaybook).toMatchObject({
      decision: 'review_first',
      nextActions: expect.arrayContaining([
        expect.objectContaining({ label: '看 Passport', description: expect.stringContaining('尚未达到当前状态') }),
      ]),
    })
  })

  it('后台 Starter Pack 可覆盖必备理由和默认示例', () => {
    const row = publicSkillSummary(
      { id: 'skill-3', slug: 'starter', title: 'Starter', isEssential: false },
      null,
      { reason: '后台推荐理由', starterExample: { topic: '周报' }, order: 2 },
    ) as any

    expect(row).toMatchObject({
      isEssential: true,
      essentialReason: '后台推荐理由',
      starterPackOrder: 2,
      starterExample: { topic: '周报' },
      starterPlaybook: {
        decision: 'start_here',
        nextActions: expect.arrayContaining([
          expect.objectContaining({
            label: '默认输入试跑',
            description: expect.stringContaining('后台已配置公开默认示例'),
          }),
        ]),
      },
    })
  })
})
