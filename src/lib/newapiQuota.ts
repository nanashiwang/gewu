import type { Payload } from 'payload'
import { getNewApiAdmin, type NewApiAdmin, type SubToken } from './newapiAdmin'
import { resolveRuntimeEnv } from './deploymentSettings'

export function quotaCreditsForUser(user: any): number {
  if (!user || user.accountStatus === 'banned') return 0
  return Math.max(0, Number(user.creditBalance || 0))
}

// 权威余额在本平台。提交后的网关同步总是读当前 creditBalance 并设置绝对 quota，
// 避免多个充值/兑换异步 delta 更新互相覆盖。
export async function syncNewApiQuotaToBalance(payload: Payload, userId: string): Promise<void> {
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const admin = getNewApiAdmin(runtimeEnv)
  const user = (await payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    overrideAccess: true,
  })) as any
  const balance = quotaCreditsForUser(user)
  await admin.provisionSubToken(userId)
  await admin.setQuotaToCredits(userId, balance)
}

// 平台代付真调用前先把网关子令牌 quota 对齐到本平台当前余额，避免历史/失败同步留下的高 quota 被继续消耗。
export async function prepareNewApiSubTokenForRun(
  admin: NewApiAdmin,
  userId: string,
  currentCreditBalance: number,
): Promise<SubToken> {
  const token = await admin.provisionSubToken(userId)
  await admin.setQuotaToCredits(userId, Math.max(0, Number(currentCreditBalance || 0)))
  return token
}
