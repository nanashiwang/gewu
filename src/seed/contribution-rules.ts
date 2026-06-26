import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'

// 术值规则（与现状行为对齐；收藏/调用加日上限与自操作排除）
const RULES = [
  { actionType: 'skill_published', basePoints: 50, dailyLimit: 0, selfActionExcluded: false, enabled: true, description: '发布通过审核' },
  { actionType: 'skill_favorited', basePoints: 1, dailyLimit: 50, selfActionExcluded: true, enabled: true, description: 'Skill 被收藏' },
  { actionType: 'skill_run', basePoints: 0.1, dailyLimit: 100, selfActionExcluded: true, enabled: true, description: 'Skill 被成功调用' },
  { actionType: 'invite', basePoints: 5, dailyLimit: 0, selfActionExcluded: true, enabled: true, description: '邀请新用户注册' },
  { actionType: 'skill_high_rating', basePoints: 10, dailyLimit: 0, selfActionExcluded: false, enabled: true, description: '获得高评分' },
  { actionType: 'skill_version_update', basePoints: 10, dailyLimit: 0, selfActionExcluded: false, enabled: true, description: '更新版本' },
]

async function run() {
  const payload = await getPayload({ config })
  for (const r of RULES) {
    const ex = await payload.find({
      collection: 'contribution-rules',
      where: { actionType: { equals: r.actionType } },
      limit: 1,
      overrideAccess: true,
    })
    if (ex.docs[0]) {
      await payload.update({ collection: 'contribution-rules', id: ex.docs[0].id, data: r as any, overrideAccess: true })
    } else {
      await payload.create({ collection: 'contribution-rules', overrideAccess: true, data: r as any })
    }
  }
  payload.logger.info(`术值规则就绪：${RULES.length} 条`)
  process.exit(0)
}

run().catch((e) => {
  console.error('规则种子失败：', e)
  process.exit(1)
})
