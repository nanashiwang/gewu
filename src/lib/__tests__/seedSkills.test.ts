import { describe, expect, it } from 'vitest'
import { SEED_SKILLS } from '@/seed/skills'
import { approvedPlatformModels } from '@/lib/constants'

describe('seed skills — 冷启动供给与平台代付合规', () => {
  it('官方种子不少于 20 个，覆盖冷启动最小供给面', () => {
    expect(SEED_SKILLS.length).toBeGreaterThanOrEqual(20)
  })

  it('必备 Skill 至少 5 个，且都有示例输入和第一跑推荐理由', () => {
    const essentials = SEED_SKILLS.filter((skill) => skill.essential)
    expect(essentials.length).toBeGreaterThanOrEqual(5)
    expect(essentials.map((skill) => skill.slug)).toEqual(
      expect.arrayContaining([
        'xhs-title-generator',
        'meeting-minutes',
        'email-polish',
        'weekly-report',
        'bad-review-reply',
      ]),
    )
    for (const skill of essentials) {
      expect(skill.examples?.[0]?.input).toBeTruthy()
      expect(skill.essentialReason?.length).toBeGreaterThan(10)
    }
  })

  it('官方种子的云端推荐和 routePolicy 只使用平台代付白名单模型', () => {
    const approved = approvedPlatformModels()
    const used = new Set<string>()
    for (const skill of SEED_SKILLS) {
      for (const model of skill.recommendedModels.cloud) used.add(model)
      for (const list of Object.values(skill.routePolicy.strategies)) {
        for (const model of list) used.add(model)
      }
    }
    expect([...used].filter((model) => !approved.has(model))).toEqual([])
  })
})
