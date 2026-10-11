import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { payload, loginFetch } = vi.hoisted(() => ({
  payload: {
    find: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    findGlobal: vi.fn(),
    db: { beginTransaction: vi.fn() },
    logger: { error: vi.fn() },
  },
  loginFetch: vi.fn(),
}))
vi.mock('payload', () => ({ getPayload: vi.fn(async () => payload) }))
vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('@/lib/contribution', () => ({ awardContribution: vi.fn() }))
vi.mock('@/lib/credit', () => ({ applyCredit: vi.fn() }))
vi.mock('@/lib/economy', () => ({
  getEconomyConfig: vi.fn(async () => ({ freeCreditOnRegister: 0 })),
}))
vi.mock('@/lib/newapiAdmin', () => ({
  getNewApiAdmin: () => ({ provisionSubToken: async () => {} }),
}))
vi.mock('@/lib/newapiQuota', () => ({ syncNewApiQuotaToBalance: vi.fn() }))
vi.mock('@/lib/deploymentSettings', () => ({
  resolveRuntimeEnv: async () => ({}),
}))
vi.mock('@/lib/clientMeta', () => ({
  getClientIp: () => '',
  hashIp: () => '',
  hashDeviceId: () => '',
}))
vi.mock('@/lib/dbLocks', () => ({ acquireInviteCodeLock: vi.fn() }))

import { POST as login } from '@/app/v1/auth/login/route'
import { POST as register } from '@/app/v1/auth/register/route'

function form(path: string, fields: Record<string, string>) {
  return new Request(`http://127.0.0.1:3109/v1/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  })
}
const registration = {
  username: 'test-account',
  password: 'test-password-only',
}

describe('账号入口：会话与无 JavaScript 回退', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', loginFetch)
    payload.find.mockResolvedValue({ docs: [{ email: 'test@example.com' }] })
    payload.count.mockResolvedValue({ totalDocs: 0 })
    payload.create.mockResolvedValue({ id: 'test-user' })
    payload.findGlobal.mockResolvedValue({ registrationEmailRequired: false })
    payload.db.beginTransaction.mockResolvedValue(null)
    loginFetch.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'set-cookie': 'payload-token=test-session; HttpOnly; Path=/',
        },
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('表单登录进入账号首页，并保留 HttpOnly 会话 cookie', async () => {
    const response = await login(
      form('login', {
        identifier: 'test@example.com',
        password: 'test-password-only',
      }),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/account')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })
  it('错误密码停留在登录页，不跳进受保护的账号页', async () => {
    loginFetch.mockResolvedValue(new Response('{}', { status: 401 }))
    const response = await login(
      form('login', { identifier: 'test@example.com', password: 'wrong' }),
    )
    expect(response.headers.get('location')).toMatch(/^\/login\?error=/)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
  it('不填邮箱或邀请码也可注册普通账号，并进入账号首页', async () => {
    const response = await register(
      form('register', { ...registration, role: 'admin' }),
    )
    expect(response.headers.get('location')).toBe('/account')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(payload.create.mock.calls[0][0].data.role).toBe('user')
  })
  it.each(['rejected', 'offline'])(
    '注册完成但自动登录 %s 时引导登录，不要求重新注册',
    async (failure) => {
      if (failure === 'offline')
        loginFetch.mockRejectedValue(new Error('test offline'))
      else loginFetch.mockResolvedValue(new Response('{}', { status: 401 }))
      const response = await register(form('register', registration))
      expect(payload.create).toHaveBeenCalledTimes(1)
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toMatch(/^\/login\?error=/)
      expect(decodeURIComponent(response.headers.get('location')!)).toContain(
        '无需重新注册',
      )
      expect(response.headers.get('set-cookie')).toBeNull()
    },
  )
  it('用户名冲突不会再次创建账号或尝试自动登录', async () => {
    payload.count.mockResolvedValue({ totalDocs: 1 })
    const response = await register(form('register', registration))
    expect(response.headers.get('location')).toMatch(/^\/register\?error=/)
    expect(payload.create).not.toHaveBeenCalled()
    expect(loginFetch).not.toHaveBeenCalled()
  })
})
