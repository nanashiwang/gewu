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
    })
    expect(row.systemPrompt).toBeUndefined()
    expect(row.promptTemplate).toBeUndefined()
    expect(row.runCount).toBeUndefined()
  })
})
