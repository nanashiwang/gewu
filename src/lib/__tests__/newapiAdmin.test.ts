import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  createNewApiAdmin,
  isRealMode,
  subTokenName,
  NewApiAdminError,
  logQuota,
  logTimestampMs,
  logTokenName,
  logModelName,
  logType,
  logTokenUsage,
  logTokenPricedQuota,
  getCreditToQuota,
} from '@/lib/newapiAdmin'

function realEnv() {
  vi.stubEnv('NEWAPI_ADMIN_BASE_URL', 'https://relay.example.com')
  vi.stubEnv('NEWAPI_ADMIN_KEY', 'access-tok')
  vi.stubEnv('NEWAPI_ADMIN_USER_ID', '1')
  vi.stubEnv('NEWAPI_SUB_GROUP', 'platform-lowcost')
  vi.stubEnv('NEWAPI_CREDIT_TO_QUOTA', '700')
}

// 按 new-api 响应形态 mock fetch；tokens 数组模拟平台账号下的令牌
function mockFetch(tokens: any[], calls: any[]) {
  return vi.fn(async (url: string, opts: any) => {
    const method = opts?.method || 'GET'
    const body = opts?.body ? JSON.parse(opts.body) : undefined
    calls.push({ url, method, body, headers: opts?.headers })
    const ok = (data: any) => new Response(JSON.stringify({ success: true, data }), { status: 200 })
    if (url.includes('/api/token/') && method === 'GET') return ok({ items: tokens })
    if (url.includes('/api/token/') && method === 'POST') {
      tokens.push({ id: 5, name: body.name, key: 'sk-new', remain_quota: body.remain_quota })
      return ok(null)
    }
    if (url.includes('/api/token/') && method === 'PUT') return ok(null)
    if (url.includes('/api/log/')) {
      const tokenName = new URL(url).searchParams.get('token_name') || ''
      return ok({
        items: [
          { type: 2, quota: 1400, token_name: tokenName, created_at: 1 },
          { type: 2, quota: 700, token_name: tokenName, created_at: 1 },
        ],
      })
    }
    return ok(null)
  })
}

function expectRollingExpiry(value: any, days = 7) {
  const now = Math.floor(Date.now() / 1000)
  expect(typeof value).toBe('number')
  expect(value).toBeGreaterThan(now)
  expect(value).toBeLessThanOrEqual(now + days * 24 * 60 * 60 + 5)
}

describe('newapiAdmin — stub 模式', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('未配置 env → stub，方法模拟成功', async () => {
    vi.stubEnv('NEWAPI_ADMIN_BASE_URL', '')
    vi.stubEnv('NEWAPI_ADMIN_KEY', '')
    expect(isRealMode()).toBe(false)
    const a = createNewApiAdmin()
    expect(a.mode).toBe('stub')
    expect(await a.provisionSubToken('u1')).toEqual({ tokenName: 'gw_u1', simulated: true })
  })
  it('子令牌命名 gw_<userId>', () => {
    expect(subTokenName('abc-123')).toBe('gw_abc-123')
  })
})

describe('newapiAdmin — real 模式(new-api 源码规格)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('缺 NEWAPI_ADMIN_USER_ID → 抛 NewApiAdminError', async () => {
    vi.stubEnv('NEWAPI_ADMIN_BASE_URL', 'https://relay.example.com')
    vi.stubEnv('NEWAPI_ADMIN_KEY', 'k')
    vi.stubEnv('NEWAPI_ADMIN_USER_ID', '')
    const a = createNewApiAdmin()
    expect(a.mode).toBe('real')
    await expect(a.adjustQuota('u1', 1)).rejects.toBeInstanceOf(NewApiAdminError)
  })

  it('provisionSubToken：先查名→无则 POST 建 gw_<id>(remain 0/有限 TTL) + 正确鉴权头', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens: any[] = []
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    const r = await a.provisionSubToken('u1')
    expect(r).toMatchObject({ tokenName: 'gw_u1', key: 'sk-new', tokenId: 5, simulated: false })
    const post = calls.find((c) => c.method === 'POST')
    expect(post.body).toMatchObject({
      name: 'gw_u1',
      remain_quota: 0,
      group: 'platform-lowcost',
      unlimited_quota: false,
      model_limits_enabled: true,
      model_limits: 'deepseek-chat,qwen-plus',
    })
    expectRollingExpiry(post.body.expired_time)
    expect(post.headers.Authorization).toBe('access-tok') // 默认不加 Bearer
    expect(post.headers['New-Api-User']).toBe('1')
  })

  it('provisionSubToken：发现历史无限配额子令牌时先关闭 unlimited_quota', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 100, unlimited_quota: true }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).resolves.toMatchObject({ tokenName: 'gw_u1', key: 'sk' })
    const put = calls.find((c) => c.method === 'PUT')
    expect(put.body).toMatchObject({
      id: 5,
      remain_quota: 100,
      unlimited_quota: false,
      model_limits_enabled: true,
      model_limits: 'deepseek-chat,qwen-plus',
    })
    expectRollingExpiry(put.body.expired_time)
  })

  it('provisionSubToken：发现历史子令牌模型限制缺失/漂移时会重写白名单', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 100, unlimited_quota: false, model_limits_enabled: false }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).resolves.toMatchObject({ tokenName: 'gw_u1', key: 'sk' })
    const put = calls.find((c) => c.method === 'PUT')
    expect(put.body).toMatchObject({
      remain_quota: 100,
      unlimited_quota: false,
      model_limits_enabled: true,
      model_limits: 'deepseek-chat,qwen-plus',
    })
  })

  it('provisionSubToken：发现历史子令牌分组漂移时会重写到低价受限分组', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [{
      id: 5,
      name: 'gw_u1',
      key: 'sk',
      remain_quota: 100,
      unlimited_quota: false,
      model_limits_enabled: true,
      model_limits: 'deepseek-chat,qwen-plus',
      group: 'default',
    }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).resolves.toMatchObject({ tokenName: 'gw_u1', key: 'sk' })
    const put = calls.find((c) => c.method === 'PUT')
    expect(put.body).toMatchObject({
      remain_quota: 100,
      unlimited_quota: false,
      model_limits_enabled: true,
      model_limits: 'deepseek-chat,qwen-plus',
      group: 'platform-lowcost',
    })
  })

  it('provisionSubToken：发现同名重复子令牌时先全部清零再 fail-closed', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [
      { id: 5, name: 'gw_u1', key: 'sk-a', remain_quota: 100, unlimited_quota: false },
      { id: 6, name: 'gw_u1', key: 'sk-b', remain_quota: 200, unlimited_quota: true },
    ]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).rejects.toThrow('同名 New API 子令牌')
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(4)
    const fullPuts = puts.filter((p) => !p.url.includes('status_only=1'))
    const statusPuts = puts.filter((p) => p.url.includes('status_only=1'))
    expect(fullPuts.map((p) => p.body.id).sort()).toEqual([5, 6])
    expect(statusPuts.map((p) => p.body.id).sort()).toEqual([5, 6])
    for (const put of puts) {
      expect(put.body.remain_quota).toBe(0)
      expect(put.body.status).toBe(2)
      expect(put.body.unlimited_quota).toBe(false)
      expect(put.body.model_limits_enabled).toBe(true)
      expect(put.body.model_limits).toBe('deepseek-chat,qwen-plus')
      expectRollingExpiry(put.body.expired_time)
    }
  })

  it('token 列表达到扫描上限时 fail-closed，避免漏掉深分页同名旧令牌', async () => {
    realEnv()
    const calls: any[] = []
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `other_${i}` }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts: any) => {
        calls.push({ url, method: opts?.method || 'GET' })
        return new Response(JSON.stringify({ success: true, data: { items: page } }), { status: 200 })
      }),
    )
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).rejects.toThrow('token 列表超过扫描上限')
    expect(calls).toHaveLength(50)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('显式空 APPROVED_PLATFORM_MODELS 时 fail-closed，不下发空 model_limits', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', ', ,')
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch([{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 99999 }], calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).rejects.toThrow('平台代付白名单不能为空')
    expect(calls).toHaveLength(0)
  })

  it('非法 NEWAPI_SUB_TOKEN_TTL_DAYS 时 fail-closed，不创建长效子令牌', async () => {
    realEnv()
    vi.stubEnv('NEWAPI_SUB_TOKEN_TTL_DAYS', '0')
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch([], calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).rejects.toThrow('NEWAPI_SUB_TOKEN_TTL_DAYS')
    expect(calls).toHaveLength(0)
  })

  it('缺 NEWAPI_SUB_GROUP 时 fail-closed，不把子令牌落到未知默认分组', async () => {
    realEnv()
    vi.stubEnv('NEWAPI_SUB_GROUP', '')
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch([{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 99999 }], calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).rejects.toThrow('NEWAPI_SUB_GROUP 必须配置')
    expect(calls).toHaveLength(0)
  })

  it('显式确认 New API 默认分组安全后允许不写 group 字段', async () => {
    realEnv()
    vi.stubEnv('NEWAPI_SUB_GROUP', '')
    vi.stubEnv('ALLOW_DEFAULT_NEWAPI_SUB_GROUP', '1')
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens: any[] = []
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).resolves.toMatchObject({ tokenName: 'gw_u1' })
    const post = calls.find((c) => c.method === 'POST')
    expect(post.body).toMatchObject({ name: 'gw_u1', group: '' })
    expectRollingExpiry(post.body.expired_time)
  })

  it('adjustQuota：读令牌→remain_quota += delta*CREDIT_TO_QUOTA→PUT(绝对值)', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 100, unlimited_quota: true }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    const r = await a.adjustQuota('u1', 2) // 2 credit × 700 = 1400
    expect(r).toMatchObject({ ok: true, remainQuota: 1500, simulated: false }) // 100+1400
    const put = calls.find((c) => c.method === 'PUT')
    expect(put.body.remain_quota).toBe(1500)
    expect(put.body.unlimited_quota).toBe(false)
    expectRollingExpiry(put.body.expired_time)
    expect(put.body.model_limits_enabled).toBe(true)
    expect(put.body.model_limits).toBe('deepseek-chat,qwen-plus')
    expect(put.body.id).toBe(5) // 传完整对象
  })

  it('setQuotaToCredits：按本平台余额设置绝对 quota，避免异步 delta 覆盖', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 99999, unlimited_quota: true }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    const r = await a.setQuotaToCredits('u1', 3) // 3 credit × 700 = 2100
    expect(r).toMatchObject({ ok: true, remainQuota: 2100, simulated: false })
    const put = calls.find((c) => c.method === 'PUT')
    expect(put.body.remain_quota).toBe(2100)
    expect(put.body.unlimited_quota).toBe(false)
    expectRollingExpiry(put.body.expired_time)
    expect(put.body.model_limits_enabled).toBe(true)
    expect(put.body.model_limits).toBe('deepseek-chat,qwen-plus')
  })

  it('setQuotaToCredits：从 0 余额充值时先禁用写 quota，再 status_only 启用', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [{ id: 5, name: 'gw_u1', key: 'sk', status: 1, remain_quota: 0, unlimited_quota: false }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.setQuotaToCredits('u1', 3)).resolves.toMatchObject({ ok: true, remainQuota: 2100 })
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts[0].url).toContain('/api/token/')
    expect(puts[0].url).not.toContain('status_only=1')
    expect(puts[0].body).toMatchObject({ id: 5, status: 2, remain_quota: 2100, unlimited_quota: false })
    expect(puts[1].url).toContain('status_only=1')
    expect(puts[1].body).toMatchObject({ id: 5, status: 1, remain_quota: 2100, unlimited_quota: false })
  })

  it('setQuotaToCredits：余额归零时禁用子令牌，避免 New API 拒绝启用零额度 token', async () => {
    realEnv()
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat,qwen-plus')
    const tokens = [{ id: 5, name: 'gw_u1', key: 'sk', status: 1, remain_quota: 100, unlimited_quota: true }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.setQuotaToCredits('u1', 0)).resolves.toMatchObject({ ok: true, remainQuota: 0 })
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts[0].body).toMatchObject({ id: 5, status: 2, remain_quota: 0, unlimited_quota: false })
    expect(puts[1].url).toContain('status_only=1')
    expect(puts[1].body).toMatchObject({ id: 5, status: 2, remain_quota: 0, unlimited_quota: false })
  })

  it('非法 NEWAPI_CREDIT_TO_QUOTA 运行时 fail-closed，不下发 null/NaN 配额', async () => {
    realEnv()
    vi.stubEnv('NEWAPI_CREDIT_TO_QUOTA', '0')
    const tokens = [{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 99999 }]
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch(tokens, calls))
    const a = createNewApiAdmin()
    await expect(a.setQuotaToCredits('u1', 3)).rejects.toThrow('NEWAPI_CREDIT_TO_QUOTA')
    expect(calls).toHaveLength(0)
  })

  it('真实模式缺 NEWAPI_CREDIT_TO_QUOTA 时 fail-closed，不使用开发默认刻度', async () => {
    realEnv()
    vi.stubEnv('NEWAPI_CREDIT_TO_QUOTA', '')
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch([{ id: 5, name: 'gw_u1', key: 'sk', remain_quota: 99999 }], calls))
    const a = createNewApiAdmin()
    await expect(a.setQuotaToCredits('u1', 3)).rejects.toThrow('必须显式配置')
    expect(calls).toHaveLength(0)
  })

  it('adjustQuota：子令牌不存在 → 抛错', async () => {
    realEnv()
    vi.stubGlobal('fetch', mockFetch([], []))
    const a = createNewApiAdmin()
    await expect(a.adjustQuota('u1', 1)).rejects.toBeInstanceOf(NewApiAdminError)
  })

  it('fetchUsage：GET /api/log type=2 聚合 quota→分(quota/CREDIT_TO_QUOTA)', async () => {
    realEnv()
    const calls: any[] = []
    vi.stubGlobal('fetch', mockFetch([], calls))
    const a = createNewApiAdmin()
    const u = await a.fetchUsage('u1', 0)
    expect(u).toMatchObject({ costCents: 3, usedQuota: 2100, calls: 2, simulated: false }) // (1400+700)/700=3
    const log = calls.find((c) => c.url.includes('/api/log/'))
    expect(log.url).toContain('type=2')
    expect(log.url).toContain('token_name=gw_u1')
  })

  it('fetchUsage：按日志模型字段分组，为不同模型倍率毛利对账提供输入', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [
                { type: 2, quota: 1400, token_name: 'gw_u1', created_at: 1, model_name: 'deepseek-chat' },
                { type: 2, quota: 700, token_name: 'gw_u1', created_at: 1, modelName: 'qwen-plus' },
                { type: 2, quota: 700, token_name: 'gw_u1', created_at: 1 },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    )
    const a = createNewApiAdmin()
    const u = await a.fetchUsage('u1', 0)
    expect(u).toMatchObject({ costCents: 4, usedQuota: 2800, calls: 3, missingModelCalls: 1 })
    expect(u.byModel).toEqual([
      {
        modelName: 'deepseek-chat',
        usedQuota: 1400,
        tokenPricedQuota: 0,
        costCents: 2,
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        modelName: 'qwen-plus',
        usedQuota: 700,
        tokenPricedQuota: 0,
        costCents: 1,
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ])
  })

  it('fetchUsage：从 New API 日志提取 input/output/cache token，供 token×价格精算', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  type: 2,
                  quota: 700,
                  token_name: 'gw_u1',
                  created_at: 1,
                  model_name: 'deepseek-chat',
                  prompt_tokens: 1000,
                  completion_tokens: 200,
                  other: JSON.stringify({ cache_tokens: 300, cache_creation_tokens: 100 }),
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    )
    const a = createNewApiAdmin()
    const u = await a.fetchUsage('u1', 0)
    expect(u.byModel).toEqual([
      {
        modelName: 'deepseek-chat',
        usedQuota: 700,
        tokenPricedQuota: 0,
        costCents: 1,
        calls: 1,
        inputTokens: 600,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheCreationTokens: 100,
      },
    ])
  })

  it('fetchUsage：admin /api/log 权限不足时可退到 /api/log/self 并继续按 token_name 验证', async () => {
    realEnv()
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('/api/log/?')) {
          return new Response(JSON.stringify({ success: false, message: '无权进行此操作，权限不足' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  type: 2,
                  quota: 700,
                  token_name: 'gw_u1',
                  created_at: 1,
                  model_name: 'deepseek-chat',
                  prompt_tokens: 10,
                  completion_tokens: 5,
                },
              ],
            },
          }),
          { status: 200 },
        )
      }),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).resolves.toMatchObject({
      costCents: 1,
      usedQuota: 700,
      byModel: [{ modelName: 'deepseek-chat', inputTokens: 10, outputTokens: 5 }],
    })
    expect(calls[0]).toContain('/api/log/?')
    expect(calls[1]).toContain('/api/log/self?')
  })

  it('fetchPricing：读取 /api/pricing + /api/status 并绑定目标分组倍率', async () => {
    realEnv()
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.endsWith('/api/pricing')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: [
                {
                  model_name: 'deepseek-chat',
                  quota_type: 0,
                  model_ratio: 0.25,
                  completion_ratio: 2,
                  supports_cache_read: true,
                  cache_ratio: 0.1,
                  supports_cache_creation: true,
                  cache_creation_ratio: 1.25,
                  enable_groups: ['platform-lowcost'],
                },
              ],
              group_ratio: { 'platform-lowcost': 0.6 },
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            success: true,
            quota_per_unit: 500000,
            usd_exchange_rate: 7.2,
          }),
          { status: 200 },
        )
      }),
    )

    const a = createNewApiAdmin()
    await expect(a.fetchPricing()).resolves.toEqual({
      models: [
        {
          modelName: 'deepseek-chat',
          quotaType: 0,
          modelRatio: 0.25,
          modelPrice: 0,
          completionRatio: 2,
          supportsCacheRead: true,
          cacheRatio: 0.1,
          supportsCacheCreation: true,
          cacheCreationRatio: 1.25,
          groupRatio: 0.6,
        },
      ],
      group: 'platform-lowcost',
      quotaPerUnit: 500000,
      usdToCny: 7.2,
      simulated: false,
    })
    expect(calls).toEqual(['https://relay.example.com/api/pricing', 'https://relay.example.com/api/status'])
  })

  it('logTokenUsage：OpenAI 风格从 prompt_tokens 扣 cache，Claude/Anthropic 不重复扣', () => {
    expect(
      logTokenUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        other: JSON.stringify({ cache_tokens: 300, cache_creation_tokens_5m: 70, cache_creation_tokens_1h: 30 }),
      }),
    ).toEqual({ inputTokens: 600, outputTokens: 200, cacheReadTokens: 300, cacheCreationTokens: 100 })
    expect(
      logTokenUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        other: JSON.stringify({ claude: true, cache_tokens: 300, cache_creation_tokens: 100 }),
      }),
    ).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheCreationTokens: 100 })
  })

  it('logTokenPricedQuota：优先使用日志 other 中的实际结算倍率复算 quota', () => {
    const record = {
      prompt_tokens: 4389,
      completion_tokens: 5,
      other: JSON.stringify({
        cache_tokens: 3840,
        model_ratio: 1.2,
        completion_ratio: 6,
        cache_ratio: 0.1,
        group_ratio: 0.85,
      }),
    }
    expect(logTokenUsage(record)).toEqual({
      inputTokens: 549,
      outputTokens: 5,
      cacheReadTokens: 3840,
      cacheCreationTokens: 0,
    })
    expect(logTokenPricedQuota(record)).toBe(982)
  })

  it('fetchUsage：分页拉全，避免月度日志超过 1000 条被截断', async () => {
    realEnv()
    const calls: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts: any) => {
        calls.push({ url, method: opts?.method || 'GET' })
        const u = new URL(url)
        const page = Number(u.searchParams.get('p') || 1)
        const items =
          page === 1
            ? Array.from({ length: 1000 }, () => ({ type: 2, quota: 700, token_name: 'gw_u1', created_at: 1 }))
            : page === 2
              ? [{ type: 2, quota: 1400, token_name: 'gw_u1', created_at: 1 }]
              : []
        return new Response(JSON.stringify({ success: true, data: { items } }), { status: 200 })
      }),
    )
    const a = createNewApiAdmin()
    const u = await a.fetchUsage('u1', 0)
    expect(u).toMatchObject({ costCents: 1002, usedQuota: 701400, calls: 1001, simulated: false })
    const logCalls = calls.filter((c) => c.url.includes('/api/log/'))
    expect(logCalls).toHaveLength(2)
    expect(logCalls[0].url).toContain('p=1')
    expect(logCalls[1].url).toContain('p=2')
  })

  it('fetchUsage：日志超过扫描上限时 fail-closed，避免真钱用量被截断低估', async () => {
    realEnv()
    const calls: any[] = []
    const fullPage = Array.from({ length: 1000 }, () => ({ type: 2, quota: 1, token_name: 'gw_u1', created_at: 1 }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts: any) => {
        calls.push({ url, method: opts?.method || 'GET' })
        return new Response(JSON.stringify({ success: true, data: { items: fullPage } }), { status: 200 })
      }),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('/api/log 超过分页扫描上限')
    expect(calls).toHaveLength(100)
    expect(calls[99].url).toContain('p=100')
  })

  it('fetchUsage：任一消费日志缺有效 quota 字段即 fail-closed，避免混合日志低估真钱用量', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 2, quota: 700, token_name: 'gw_u1', created_at: 1 }, { type: 2, token_name: 'gw_u1', created_at: 1, model_name: 'deepseek-chat' }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('缺少有效 quota 字段')
  })

  it('fetchUsage：日志缺消费 type=2 即 fail-closed，避免 type 过滤失效混入非消费日志', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ quota: 700, token_name: 'gw_u1', created_at: 1 }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('消费 type=2')
  })

  it('fetchUsage：返回非消费 type 记录即 fail-closed', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 1, quota: 700, token_name: 'gw_u1', created_at: 1 }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('消费 type=2')
  })

  it('fetchUsage：返回退款 type=6 记录即 fail-closed，避免退款口径混入消费验收', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 6, quota: 700, token_name: 'gw_u1', created_at: 1 }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('退款记录')
  })

  it('fetchUsage：返回退款标记记录即 fail-closed，避免正 quota 被误当消费', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 2, quota: 700, token_name: 'gw_u1', created_at: 1, is_refund: true }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('退款相关记录')
  })

  it('fetchUsage：返回异常流式结算记录即 fail-closed，避免预消费/退款状态误验收', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 2, quota: 700, token_name: 'gw_u1', created_at: 1, stream_status: { status: 'error' } }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('异常流式结算记录')
  })

  it('fetchUsage：日志缺 token_name 即 fail-closed，避免过滤参数被忽略仍误验收', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 2, quota: 700, created_at: 1 }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('缺少 token_name')
  })

  it('fetchUsage：返回非目标 token_name 即 fail-closed，避免混入他人真钱日志', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 2, quota: 700, token_name: 'gw_u2', created_at: 1 }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('非目标子令牌记录')
  })

  it('fetchUsage：日志缺时间戳即 fail-closed，避免 start_timestamp 被忽略仍误验收', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 2, quota: 700, token_name: 'gw_u1' }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('缺少有效时间戳')
  })

  it('fetchUsage：返回早于 start_timestamp 的记录即 fail-closed', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { items: [{ type: 2, quota: 700, token_name: 'gw_u1', created_at: 9 }] } }), {
          status: 200,
        }),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 10_000)).rejects.toThrow('早于 start_timestamp')
  })

  it('fetchUsage：返回荒谬未来时间记录即 fail-closed，避免真钱账期被未来日志污染', async () => {
    realEnv()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T00:00:00.000Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  type: 2,
                  quota: 700,
                  token_name: 'gw_u1',
                  created_at: Math.floor((Date.now() + 10 * 60 * 1000) / 1000),
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).rejects.toThrow('未来时间记录')
  })

  it('fetchUsage：允许网关时钟轻微超前，避免正常秒级偏差误伤', async () => {
    realEnv()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T00:00:00.000Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  type: 2,
                  quota: 700,
                  token_name: 'gw_u1',
                  created_at: Math.floor((Date.now() + 60 * 1000) / 1000),
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    )
    const a = createNewApiAdmin()
    await expect(a.fetchUsage('u1', 0)).resolves.toMatchObject({ costCents: 1, usedQuota: 700 })
  })

  it('New API 返回 success:false → 抛 NewApiAdminError', async () => {
    realEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false, message: '无权限' }), { status: 200 })),
    )
    const a = createNewApiAdmin()
    await expect(a.provisionSubToken('u1')).rejects.toBeInstanceOf(NewApiAdminError)
  })

  it('logQuota：兼容 quota 别名并拒绝缺失/负值，避免误把有调用无 quota 当真钱闭环', () => {
    expect(logQuota({ quota: 700 })).toBe(700)
    expect(logQuota({ used_quota: '1400' })).toBe(1400)
    expect(logQuota({ quota_used: 2100 })).toBe(2100)
    expect(logQuota({})).toBe(0)
    expect(logQuota({ quota: -1 })).toBe(0)
  })

  it('logTokenName：兼容 New API 日志 token_name 别名', () => {
    expect(logTokenName({ token_name: 'gw_u1' })).toBe('gw_u1')
    expect(logTokenName({ tokenName: 'gw_u1' })).toBe('gw_u1')
    expect(logTokenName({ token: { name: 'gw_u1' } })).toBe('gw_u1')
    expect(logTokenName({})).toBe('')
  })

  it('logModelName：兼容 New API 日志模型字段别名', () => {
    expect(logModelName({ model_name: 'deepseek-chat' })).toBe('deepseek-chat')
    expect(logModelName({ modelName: 'qwen-plus' })).toBe('qwen-plus')
    expect(logModelName({ model: { name: 'glm-4' } })).toBe('glm-4')
    expect(logModelName({})).toBe('')
  })

  it('logTimestampMs：兼容秒/毫秒/ISO 时间戳', () => {
    expect(logTimestampMs({ created_at: 10 })).toBe(10_000)
    expect(logTimestampMs({ createdAt: 10_000_000_000_000 })).toBe(10_000_000_000_000)
    expect(logTimestampMs({ timestamp: '1970-01-01T00:00:10.000Z' })).toBe(10_000)
    expect(logTimestampMs({})).toBe(0)
  })

  it('logType：兼容 New API 日志 type 别名', () => {
    expect(logType({ type: 2 })).toBe(2)
    expect(logType({ log_type: '2' })).toBe(2)
    expect(logType({ logType: 2 })).toBe(2)
    expect(Number.isNaN(logType({}))).toBe(true)
  })

  it('getCreditToQuota：空值用开发默认，非法值抛错', () => {
    expect(getCreditToQuota({})).toBe(700)
    expect(getCreditToQuota({ NEWAPI_CREDIT_TO_QUOTA: '1234' })).toBe(1234)
    expect(() => getCreditToQuota({ NEWAPI_CREDIT_TO_QUOTA: 'NaN' })).toThrow('NEWAPI_CREDIT_TO_QUOTA')
    expect(() => getCreditToQuota({}, { requireExplicit: true })).toThrow('必须显式配置')
  })
})
