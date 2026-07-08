import { describe, expect, it } from 'vitest'
import { skillPublishPlaybook } from '@/lib/skillPublishPlaybook'

describe('skillPublishPlaybook — 创作者发布后维护指引', () => {
  it('发布成功后给出 Contract/Passport/证书/失败库维护路径', () => {
    const playbook = skillPublishPlaybook({ slug: 'writer', status: 'published', autoPublished: true })
    expect(playbook).toMatchObject({
      customerValue: expect.stringContaining('可维护资产'),
      decision: 'maintain',
      nextActions: expect.arrayContaining([
        expect.objectContaining({ label: '核对 Contract', href: '/v1/skills/writer/contract' }),
        expect.objectContaining({ label: '刷新 Passport', href: '/v1/skills/writer/passport' }),
        expect.objectContaining({ label: '验签证书', href: '/verify?certificateUrl=%2Fv1%2Fskills%2Fwriter%2Fcertificate' }),
        expect.objectContaining({ label: '用失败库维护', href: '/failures?skill=writer' }),
      ]),
    })
  })

  it('待审和驳回分别给出 review/revise 状态', () => {
    expect(skillPublishPlaybook({ slug: 'pending', status: 'pending' }).decision).toBe('review')
    expect(skillPublishPlaybook({ slug: 'bad', status: 'pending', reviewDecision: 'reject' }).decision).toBe('revise')
  })
})
