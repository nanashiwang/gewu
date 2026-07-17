import { describe, expect, it } from 'vitest'
import { prepareNewApiSubTokenForRun, quotaCreditsForUser } from '@/lib/newapiQuota'

describe('newapiQuota — 子令牌绝对 quota 目标', () => {
  it('正常用户按本平台 creditBalance 同步', () => {
    expect(quotaCreditsForUser({ accountStatus: 'active', creditBalance: 12.5 })).toBe(12.5)
  })

  it('封禁用户一律归零，防外部子令牌继续消耗', () => {
    expect(quotaCreditsForUser({ accountStatus: 'banned', creditBalance: 999 })).toBe(0)
  })

  it('负余额/空用户归零', () => {
    expect(quotaCreditsForUser({ accountStatus: 'active', creditBalance: -3 })).toBe(0)
    expect(quotaCreditsForUser(null)).toBe(0)
  })

  it('平台代付真调用前先按本平台当前余额覆盖子令牌 quota', async () => {
    const calls: string[] = []
    const admin = {
      mode: 'real' as const,
      provisionSubToken: async (userId: string) => {
        calls.push(`provision:${userId}`)
        return { tokenName: `gw_${userId}`, key: 'sk-sub', simulated: false }
      },
      setQuotaToCredits: async (userId: string, credits: number) => {
        calls.push(`quota:${userId}:${credits}`)
        return { ok: true, remainQuota: credits * 700, simulated: false }
      },
      adjustQuota: async () => ({ ok: true, simulated: false }),
      fetchUsage: async () => ({ costCents: 0, usedQuota: 0, calls: 0, byModel: [], missingModelCalls: 0, simulated: false }),
      fetchPricing: async () => ({ models: [], group: 'stub', quotaPerUnit: 500000, usdToCny: 7, simulated: false }),
    }

    const token = await prepareNewApiSubTokenForRun(admin, 'u1', 12.5)
    expect(token.key).toBe('sk-sub')
    expect(calls).toEqual(['provision:u1', 'quota:u1:12.5'])
  })
})
