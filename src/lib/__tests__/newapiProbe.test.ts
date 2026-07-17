import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyNewApiProbe, redactNewApiProbeText, runNewApiPermissionProbe } from '@/lib/newapiProbe'

describe('newapiProbe — 管理权限探测分类', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('不把 sk/用户子令牌名写入探测输出', () => {
    const s = redactNewApiProbeText('bad sk-abcdef1234567890 for gw_user-1')
    expect(s).not.toContain('abcdef1234567890')
    expect(s).not.toContain('gw_user-1')
  })

  it('不把管理 access token 写入探测输出', () => {
    vi.stubEnv('NEWAPI_ADMIN_KEY', 'admin-secret-token-123456')
    const s = redactNewApiProbeText('upstream echoed admin-secret-token-123456')
    expect(s).not.toContain('admin-secret-token-123456')
    expect(s).toContain('<redacted>')
  })

  it('token OK 但 log FAIL 时提示兑换保持关闭', () => {
    const r = classifyNewApiProbe([
      { path: '/api/token/?p=1', ok: true },
      { path: '/api/log/?p=1', ok: false },
    ])
    expect(r.tokenOK).toBe(true)
    expect(r.logOK).toBe(false)
    expect(r.hint).toContain('兑换池必须保持关闭')
  })

  it('log 可访问但 token_name 过滤返回记录时提示不能验收', () => {
    const r = classifyNewApiProbe([
      { path: '/api/token/?p=1', ok: true },
      { path: '/api/log/?p=1', ok: true },
      { path: '/api/log/?type=2&token_name=gw_preflight_impossible_1&p=1&page_size=1', ok: true, recordCount: 1 },
    ])
    expect(r.logOK).toBe(true)
    expect(r.logFilterOK).toBe(false)
    expect(r.hint).toContain('过滤不可证明有效')
  })

  it('log 可访问但 start_timestamp 未来窗返回记录时提示不能验收', () => {
    const r = classifyNewApiProbe([
      { path: '/api/token/?p=1', ok: true },
      { path: '/api/log/?p=1', ok: true },
      { path: '/api/log/?type=2&token_name=gw_preflight_impossible_1&p=1&page_size=1', ok: true, recordCount: 0 },
      { path: '/api/log/?type=2&start_timestamp=9999999999&p=1&page_size=1', ok: true, recordCount: 1 },
    ])
    expect(r.logOK).toBe(true)
    expect(r.logFilterOK).toBe(true)
    expect(r.logTimeFilterOK).toBe(false)
    expect(r.hint).toContain('start_timestamp 过滤不可证明有效')
  })

  it('token/log/token/time 过滤都通过时允许进入校准', () => {
    const r = classifyNewApiProbe([
      { path: '/api/token/?p=1', ok: true },
      { path: '/api/log/?p=1', ok: true },
      { path: '/api/log/?type=2&p=1&page_size=5', ok: true, recordCount: 1, ambiguousSettlementCount: 0 },
      { path: '/api/log/?type=2&token_name=gw_preflight_impossible_1&p=1&page_size=1', ok: true, recordCount: 0 },
      { path: '/api/log/?type=2&start_timestamp=9999999999&p=1&page_size=1', ok: true, recordCount: 0 },
      { path: '/api/pricing', ok: true, recordCount: 1 },
      { path: '/api/status', ok: true },
    ])
    expect(r).toMatchObject({
      tokenOK: true,
      logOK: true,
      logFilterOK: true,
      logTimeFilterOK: true,
      logSettlementOK: true,
      pricingOK: true,
      statusOK: true,
      logScope: 'admin',
    })
  })

  it('admin log 不通但 self log 可按 token/time 过滤时允许用个人日志口径', () => {
    const r = classifyNewApiProbe([
      { path: '/api/token/?p=1', ok: true },
      { path: '/api/log/?p=1', ok: false },
      { path: '/api/log/self?p=1', ok: true },
      { path: '/api/log/self?type=2&p=1&page_size=5', ok: true, recordCount: 1, ambiguousSettlementCount: 0 },
      { path: '/api/log/self?type=2&token_name=gw_preflight_impossible_1&p=1&page_size=1', ok: true, recordCount: 0 },
      { path: '/api/log/self?type=2&start_timestamp=9999999999&p=1&page_size=1', ok: true, recordCount: 0 },
      { path: '/api/pricing', ok: true, recordCount: 1 },
      { path: '/api/status', ok: true },
    ])
    expect(r).toMatchObject({ logOK: true, logScope: 'self', logFilterOK: true, logTimeFilterOK: true })
  })

  it('log 通过但 pricing/status 不完整时提示不能精算成本', () => {
    const base = [
      { path: '/api/token/?p=1', ok: true },
      { path: '/api/log/?p=1', ok: true },
      { path: '/api/log/?type=2&p=1&page_size=5', ok: true, recordCount: 1, ambiguousSettlementCount: 0 },
      { path: '/api/log/?type=2&token_name=gw_preflight_impossible_1&p=1&page_size=1', ok: true, recordCount: 0 },
      { path: '/api/log/?type=2&start_timestamp=9999999999&p=1&page_size=1', ok: true, recordCount: 0 },
    ]
    expect(classifyNewApiProbe([...base, { path: '/api/pricing', ok: false }, { path: '/api/status', ok: true }]).hint).toContain('/api/pricing')
    expect(classifyNewApiProbe([...base, { path: '/api/pricing', ok: true }, { path: '/api/status', ok: false }]).hint).toContain('/api/status')
  })

  it('log 样本含退款/异常流式结算时提示不能验收', () => {
    const r = classifyNewApiProbe([
      { path: '/api/token/?p=1', ok: true },
      { path: '/api/log/?p=1', ok: true },
      { path: '/api/log/?type=2&p=1&page_size=5', ok: true, recordCount: 1, ambiguousSettlementCount: 1 },
      { path: '/api/log/?type=2&token_name=gw_preflight_impossible_1&p=1&page_size=1', ok: true, recordCount: 0 },
      { path: '/api/log/?type=2&start_timestamp=9999999999&p=1&page_size=1', ok: true, recordCount: 0 },
    ])
    expect(r.logSettlementOK).toBe(false)
    expect(r.hint).toContain('退款/异常流式结算')
  })


  it('token FAIL 时提示不要把模型 sk Key 当管理 token', () => {
    const r = classifyNewApiProbe([{ path: '/api/token/?p=1', ok: false }])
    expect(r.hint).toContain('不是模型 sk Key')
  })

  it('在线探测同时检查 token 与 log，并脱敏错误信息', async () => {
    const calls: string[] = []
    const checks = await runNewApiPermissionProbe({
      baseUrl: 'https://newapi.example.com/',
      key: 'admin-secret-token-abcdef',
      userId: '1001',
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.includes('/api/token/')) {
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ success: true, data: { items: [] } }),
          }
        }
        if (url.includes('token_name=gw_preflight_impossible')) {
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ success: true, data: { items: [] } }),
          }
        }
        if (url.includes('/api/log/?type=2&p=1&page_size=5')) {
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ success: true, data: { items: [] } }),
          }
        }
        if (url.includes('start_timestamp=')) {
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ success: true, data: { items: [] } }),
          }
        }
        if (url.includes('/api/pricing')) {
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ success: true, data: [{ model_name: 'deepseek-chat' }], group_ratio: { default: 1 } }),
          }
        }
        if (url.includes('/api/status')) {
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ success: true, quota_per_unit: 500000, usd_exchange_rate: 7 }),
          }
        }
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({ success: false, message: 'bad admin-secret-token-abcdef for gw_user-1' }),
        }
      },
    })

    expect(calls).toEqual([
      'https://newapi.example.com/api/token/?p=1&page_size=1',
      'https://newapi.example.com/api/log/?p=1&page_size=1',
      'https://newapi.example.com/api/log/?type=2&p=1&page_size=5',
      expect.stringMatching(/^https:\/\/newapi\.example\.com\/api\/log\/\?type=2&token_name=gw_preflight_impossible_/),
      expect.stringMatching(/^https:\/\/newapi\.example\.com\/api\/log\/\?type=2&start_timestamp=/),
      'https://newapi.example.com/api/log/self?p=1&page_size=1',
      'https://newapi.example.com/api/log/self?type=2&p=1&page_size=5',
      expect.stringMatching(/^https:\/\/newapi\.example\.com\/api\/log\/self\?type=2&token_name=gw_preflight_impossible_/),
      expect.stringMatching(/^https:\/\/newapi\.example\.com\/api\/log\/self\?type=2&start_timestamp=/),
      'https://newapi.example.com/api/pricing',
      'https://newapi.example.com/api/status',
    ])
    expect(classifyNewApiProbe(checks)).toMatchObject({ tokenOK: true, logOK: false })
    expect(checks[1].message).not.toContain('admin-secret-token-abcdef')
    expect(checks[1].message).not.toContain('gw_user-1')
  })

  it('单个探测网络失败时返回失败项而不是让整次预检崩掉', async () => {
    const checks = await runNewApiPermissionProbe({
      baseUrl: 'https://newapi.example.com/',
      key: 'admin-secret-token-abcdef',
      userId: '1001',
      fetchImpl: async (url) => {
        if (url.includes('/api/token/')) {
          return {
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ success: true, data: { items: [] } }),
          }
        }
        throw new Error('network leaked admin-secret-token-abcdef')
      },
    })
    expect(checks).toHaveLength(11)
    expect(checks[0]).toMatchObject({ ok: true })
    expect(checks[1]).toMatchObject({ ok: false, status: 0, shape: 'network-error' })
    expect(checks[1].message).not.toContain('admin-secret-token-abcdef')
  })

  it('在线探测会统计退款/异常流式结算样本但不输出原文', async () => {
    const checks = await runNewApiPermissionProbe({
      baseUrl: 'https://newapi.example.com/',
      key: 'admin-secret-token-abcdef',
      userId: '1001',
      fetchImpl: async (url) => ({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: {
              items: url.includes('/api/log/?type=2&p=1&page_size=5')
                ? [{ type: 2, quota: 700, token_name: 'gw_u1', stream_status: { status: 'error' } }]
                : [],
            },
          }),
      }),
    })
    const sample = checks.find((c) => c.path.includes('/api/log/?type=2&p=1'))
    expect(sample?.ambiguousSettlementCount).toBe(1)
    expect(classifyNewApiProbe(checks).logSettlementOK).toBe(false)
  })
})
