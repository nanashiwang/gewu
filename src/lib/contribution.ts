import type { Payload, PayloadRequest } from 'payload'
import type { ContributionAction } from './constants'

/**
 * 发放术值：以 ContributionRules 为准取分值，并做反作弊前置校验。
 *
 * 规则优先级：
 *  1. 查 actionType 对应规则；规则 enabled=false → 不发；
 *  2. selfActionExcluded 且 actorId===userId → 不发（防自操作刷分）；
 *  3. 取分值：有规则用 rule.basePoints，否则回退传入 points（向后兼容）；
 *  4. dailyLimit>0：当日该 actionType 发放次数达上限 → 不发；
 *  5. 创建 ContributionLog 并原子更新 user.contributionScore。
 *
 * ⚠️ 在 Collection Hook 内调用须透传 req（共享父事务，避免死锁）。
 */
export async function awardContribution(
  payload: Payload,
  args: {
    userId: string
    actionType: ContributionAction
    points?: number // 回退值（无规则时使用）
    actorId?: string // 触发者（用于自操作排除）
    relatedSkill?: string
    relatedBounty?: string
    description?: string
    req?: PayloadRequest
  },
): Promise<void> {
  const { userId, actionType, actorId, req } = args
  if (!userId) return
  const tx = req ? { req } : {}

  try {
    const ruleRes = await payload.find({
      collection: 'contribution-rules',
      where: { actionType: { equals: actionType } },
      limit: 1,
      overrideAccess: true,
      ...tx,
    })
    const rule = ruleRes.docs[0] as any

    if (rule && rule.enabled === false) return
    if (rule?.selfActionExcluded && actorId && actorId === userId) return

    const points = rule ? rule.basePoints : args.points
    if (!points) return

    if (rule?.dailyLimit && rule.dailyLimit > 0) {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const todays = await payload.count({
        collection: 'contribution-logs',
        where: {
          and: [
            { user: { equals: userId } },
            { actionType: { equals: actionType } },
            { createdAt: { greater_than_equal: start.toISOString() } },
          ],
        },
        overrideAccess: true,
        ...tx,
      })
      if (todays.totalDocs >= rule.dailyLimit) return
    }

    const user = await payload.findByID({
      collection: 'users',
      id: userId,
      overrideAccess: true,
      depth: 0,
      ...tx,
    })
    await payload.update({
      collection: 'users',
      id: userId,
      data: { contributionScore: (user.contributionScore || 0) + points },
      overrideAccess: true,
      ...tx,
    })
    await payload.create({
      collection: 'contribution-logs',
      data: {
        user: userId,
        actionType,
        points,
        relatedSkill: args.relatedSkill,
        relatedBounty: args.relatedBounty,
        description: args.description,
      },
      overrideAccess: true,
      ...tx,
    })
  } catch (e) {
    payload.logger?.error(`awardContribution 失败: ${(e as Error).message}`)
  }
}
