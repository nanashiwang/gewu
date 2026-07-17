import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeRedisFixedWindow,
  consumeRedisRunRateLimit,
  consumeRunRateLimit,
  consumeStrictRedisRateLimit,
  fixedRateLimitKey,
  parseRedisRateLimitResult,
  runRateLimitKey,
} from '@/lib/rateLimit'

describe('rateLimit — 运行频控', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('Redis key 使用哈希 userId，不把原始 id 拼进 key', () => {
    const key = runRateLimitKey("u1'); DROP TABLE users; --")
    expect(key).toMatch(/^gw:rl:run:60:[0-9a-f]{32}$/)
    expect(key).not.toContain('DROP TABLE')
  })

  it('解析 Redis EVAL 返回值：超过上限即拒绝', () => {
    expect(parseRedisRateLimitResult([1, 3, 59], 12)).toMatchObject({
      allowed: true,
      backend: 'redis',
      count: 3,
      resetSeconds: 59,
    })
    expect(parseRedisRateLimitResult([0, 13, 41], 12)).toMatchObject({
      allowed: false,
      backend: 'redis',
      count: 13,
      resetSeconds: 41,
    })
  })

  it('Redis 原子限流使用 EVAL + 单 key + limit/window 参数', async () => {
    const evalFn = vi.fn(async () => [1, 1, 60])
    const res = await consumeRedisRunRateLimit({ eval: evalFn }, 'user-1', 12)

    expect(res.allowed).toBe(true)
    expect(evalFn).toHaveBeenCalledWith(expect.stringContaining('INCR'), {
      keys: [runRateLimitKey('user-1')],
      arguments: ['12', '60'],
    })
  })

  it('通用严格限流 key 也哈希 subject，并清洗 scope', async () => {
    const key = fixedRateLimitKey("recharge');DROP", 'user-1', 600)
    expect(key).toMatch(/^gw:rl:recharge___DROP:600:[0-9a-f]{32}$/)
    expect(key).not.toContain('user-1')

    const evalFn = vi.fn(async () => [1, 1, 600])
    await consumeRedisFixedWindow({ eval: evalFn }, key, 10, 600)
    expect(evalFn).toHaveBeenCalledWith(expect.stringContaining('INCR'), {
      keys: [key],
      arguments: ['10', '600'],
    })
  })

  it('没有 Redis 时，BYOK 路径降级到 DB 窗口计数', async () => {
    vi.stubEnv('REDIS_URL', '')
    const payload = {
      count: vi.fn(async () => ({ totalDocs: 2 })),
      logger: { error: vi.fn() },
    } as any

    const res = await consumeRunRateLimit({
      payload,
      userId: 'user-1',
      limit: 3,
      platformPaid: false,
    })

    expect(res).toMatchObject({ allowed: true, backend: 'db', count: 2 })
    expect(payload.count).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'skill-runs',
        overrideAccess: true,
      }),
    )
  })

  it('生产平台代付缺 Redis 时 fail-closed，不退回单机 DB 计数', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REDIS_URL', '')
    const payload = {
      count: vi.fn(async () => ({ totalDocs: 0 })),
      logger: { error: vi.fn() },
    } as any

    const res = await consumeRunRateLimit({
      payload,
      userId: 'user-1',
      limit: 12,
      platformPaid: true,
    })

    expect(res).toMatchObject({
      allowed: false,
      backend: 'unavailable',
      unavailable: true,
      error: 'redis_not_configured',
    })
    expect(payload.count).not.toHaveBeenCalled()
  })

  it('严格资金入口限流：生产缺 Redis 时 fail-closed', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REDIS_URL', '')
    const payload = { logger: { error: vi.fn() } } as any

    const res = await consumeStrictRedisRateLimit({
      payload,
      scope: 'recharge',
      subject: 'user-1',
      limit: 10,
      windowSeconds: 600,
    })

    expect(res).toMatchObject({
      allowed: false,
      backend: 'unavailable',
      unavailable: true,
      error: 'redis_not_configured',
    })
  })
})
