import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelaySites } from '@/collections/RelaySites'
import { RelayChecks } from '@/collections/RelayChecks'
import { decryptSecret } from '@/lib/secrets'
import {
  createRelayClaimToken,
  createRelaySlug,
  isBlockedRelayHostname,
  nextRelayCheckAt,
  normalizePublicHttpUrl,
  normalizeRelayApiUrl,
  normalizeRelaySiteInput,
  relayClaimDomain,
  relayClaimRecord,
  relayGrade,
} from '@/lib/relaySite'
import { relaySiteDto, sameOriginMutationAllowed } from '@/lib/relayApi'

const callAccess = (fn: any, user: any, extra: Record<string, unknown> = {}) => fn({ req: { user }, ...extra } as any)

describe('relay site validation', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('normalizes public URLs and strips fragments/trailing slashes', () => {
    expect(normalizePublicHttpUrl('https://API.Example.com/v1/#secret', 'API 地址')).toBe('https://api.example.com/v1')
    expect(relayClaimDomain('https://api.example.com/v1')).toBe('api.example.com')
  })

  it.each([
    'http://127.0.0.1:8765',
    'http://10.0.0.1',
    'http://172.16.1.2',
    'http://192.168.1.1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]',
    'http://service.internal',
    'http://localhost',
  ])('blocks SSRF-prone target %s', (url) => {
    expect(() => normalizePublicHttpUrl(url, 'API 地址')).toThrow('不能指向')
  })

  it('blocks credentials, unsafe schemes, plaintext API transport, and query-bearing API bases', () => {
    expect(() => normalizePublicHttpUrl('https://user:pass@example.com/v1', 'API 地址')).toThrow('用户名或密码')
    expect(() => normalizePublicHttpUrl('file:///etc/passwd', 'API 地址')).toThrow('http/https')
    expect(() => normalizeRelayApiUrl('http://api.example.com/v1')).toThrow('必须使用 HTTPS')
    expect(() => normalizeRelayApiUrl('https://api.example.com/v1?token=secret')).toThrow('查询参数')
    expect(normalizeRelayApiUrl('https://API.Example.com/v1/')).toBe('https://api.example.com/v1')
    expect(isBlockedRelayHostname('api.example.com')).toBe(false)
  })

  it('validates contacts, model, schedule and API key without leaking extra input', () => {
    const result = normalizeRelaySiteInput({
      name: '测试中转',
      websiteUrl: 'https://example.com',
      apiBaseUrl: 'https://api.example.com/v1',
      description: '说明',
      protocol: 'openai',
      model: 'gpt-5.4',
      mode: 'standard',
      contacts: [
        { type: 'email', value: 'owner@example.com', isPublic: true },
        { type: 'wechat', value: 'owner-wechat' },
      ],
      scheduleEnabled: true,
      scheduleIntervalHours: 24,
      apiKey: 'sk-test-12345678',
      status: 'approved',
      owner: 'victim',
    }) as any
    expect(result.contacts).toEqual([
      { type: 'email', value: 'owner@example.com', isPublic: true },
      { type: 'wechat', value: 'owner-wechat', isPublic: false },
    ])
    expect(result.status).toBeUndefined()
    expect(result.owner).toBeUndefined()
  })

  it('rejects malformed contacts and unsupported schedule intervals', () => {
    const base = {
      name: '测试中转', websiteUrl: 'https://example.com', apiBaseUrl: 'https://api.example.com/v1',
      description: '', protocol: 'openai', model: 'gpt-5.4', mode: 'standard', scheduleEnabled: false,
    }
    expect(() => normalizeRelaySiteInput({ ...base, contacts: [{ type: 'email', value: 'not-an-email' }], scheduleIntervalHours: 24 })).toThrow('邮箱格式')
    expect(() => normalizeRelaySiteInput({ ...base, contacts: [], scheduleIntervalHours: 24 })).toThrow('至少填写 1 个有效联系方式')
    expect(() => normalizeRelaySiteInput({ ...base, scheduleIntervalHours: 24 })).toThrow('至少填写 1 个有效联系方式')
    expect(() => normalizeRelaySiteInput({ ...base, contacts: [{ type: 'wechat', value: 'owner-wechat' }], scheduleIntervalHours: 1 })).toThrow('间隔无效')
  })

  it('creates unguessable claim tokens/slugs and exact DNS records', () => {
    const token = createRelayClaimToken()
    expect(token.length).toBeGreaterThanOrEqual(32)
    const slug = createRelaySlug('格物', 'https://api.example.com/v1')
    expect(slug).toMatch(/^api-example-com-[a-f0-9]{8}$/)
    expect(relayClaimRecord('api.example.com', token)).toEqual({
      name: '_gewu-verify.api.example.com',
      value: `gewu-site-verification=${token}`,
    })
  })

  it('uses bounded grades and deterministic next schedule', () => {
    expect(relayGrade(95)).toBe('A')
    expect(relayGrade(89)).toBe('B')
    expect(relayGrade(30)).toBe('F')
    expect(nextRelayCheckAt(24, new Date('2026-07-18T00:00:00.000Z'))).toBe('2026-07-19T00:00:00.000Z')
  })
})

describe('relay collection access and hooks', () => {
  const owner = { id: 'u1', role: 'user', accountStatus: 'active' }
  const other = { id: 'u2', role: 'user', accountStatus: 'active' }
  const reviewer = { id: 'r1', role: 'reviewer', accountStatus: 'active' }
  const bannedAdmin = { id: 'a1', role: 'admin', accountStatus: 'banned' }

  it('only exposes approved sites publicly and private records to their owner/staff', () => {
    expect(callAccess(RelaySites.access?.read, null)).toEqual({ status: { equals: 'approved' } })
    expect(callAccess(RelaySites.access?.read, owner)).toEqual({ or: [{ status: { equals: 'approved' } }, { owner: { equals: 'u1' } }] })
    expect(callAccess(RelaySites.access?.read, reviewer)).toBe(true)
    expect(callAccess(RelaySites.access?.read, bannedAdmin)).toEqual({ status: { equals: 'approved' } })
    expect(callAccess(RelaySites.access?.update, other)).toEqual({ owner: { equals: 'u2' } })
  })

  it('keeps checks append-only and only exposes completed approved history publicly', () => {
    expect(callAccess(RelayChecks.access?.read, null)).toEqual({ and: [{ status: { equals: 'done' } }, { 'site.status': { equals: 'approved' } }] })
    expect(callAccess(RelayChecks.access?.create, reviewer)).toBe(false)
    expect(callAccess(RelayChecks.access?.update, reviewer)).toBe(false)
    expect(callAccess(RelayChecks.access?.delete, reviewer)).toBe(false)
  })

  it('never allows raw API key field reads/writes, including admin', () => {
    const field = RelaySites.fields.find((item: any) => item.name === 'apiKeyEncrypted') as any
    const admin = { id: 'a1', role: 'admin', accountStatus: 'active' }
    expect(callAccess(field.access.read, admin)).toBe(false)
    expect(callAccess(field.access.create, admin)).toBe(false)
    expect(callAccess(field.access.update, admin)).toBe(false)
  })

  it('encrypts service-side key writes and rejects schedule without a key', async () => {
    vi.stubEnv('PAYLOAD_SECRET', 'relay-test-secret-at-least-32-bytes')
    const hook = RelaySites.hooks?.beforeValidate?.[0] as any
    const result = await hook({
      operation: 'update',
      data: { apiKeyEncrypted: 'sk-relay-12345678', scheduleEnabled: true },
      originalDoc: { owner: 'u1', apiBaseUrl: 'https://api.example.com/v1', contacts: [{ type: 'wechat', value: 'owner-wechat', isPublic: false }], status: 'draft' },
      req: { user: null },
    })
    expect(result.apiKeyEncrypted).toMatch(/^enc:v1:/)
    expect(decryptSecret(result.apiKeyEncrypted)).toBe('sk-relay-12345678')
    expect(result.hasApiKey).toBe(true)

    expect(() => hook({
      operation: 'create',
      data: { owner: 'u1', name: '测试中转', websiteUrl: 'https://example.com', apiBaseUrl: 'https://api.example.com', protocol: 'openai', model: 'gpt-5.4', mode: 'standard', contacts: [{ type: 'wechat', value: 'owner-wechat' }], scheduleEnabled: true, scheduleIntervalHours: '24' },
      req: { user: null },
    })).toThrow('必须配置 API Key')
  })

  it('requires an operational contact on every collection write path', async () => {
    const hook = RelaySites.hooks?.beforeValidate?.[0] as any
    expect(() => hook({
      operation: 'create',
      data: { owner: 'u1', name: '测试中转', websiteUrl: 'https://example.com', apiBaseUrl: 'https://api.example.com', protocol: 'openai', model: 'gpt-5.4', mode: 'standard', contacts: [], scheduleEnabled: false, scheduleIntervalHours: '24' },
      req: { user: null },
    })).toThrow('至少填写 1 个有效联系方式')

    expect(() => hook({
      operation: 'update',
      data: { contacts: [] },
      originalDoc: { owner: 'u1', apiBaseUrl: 'https://api.example.com', contacts: [{ type: 'wechat', value: 'owner-wechat', isPublic: false }], status: 'draft' },
      req: { user: owner },
    })).toThrow('至少填写 1 个有效联系方式')
  })

  it('prevents approving an unverified site even through the raw admin collection', async () => {
    const hook = RelaySites.hooks?.beforeValidate?.[0] as any
    expect(() => hook({
      operation: 'update',
      data: { status: 'approved' },
      originalDoc: { owner: 'u1', apiBaseUrl: 'https://api.example.com', contacts: [{ type: 'wechat', value: 'owner-wechat', isPublic: false }], claimStatus: 'unverified', status: 'pending' },
      req: { user: reviewer },
    })).toThrow('不能通过审核')
  })

  it('resets claim when a non-staff owner changes the API domain', async () => {
    const hook = RelaySites.hooks?.beforeValidate?.[0] as any
    const result = await hook({
      operation: 'update',
      data: { apiBaseUrl: 'https://new.example.net/v1' },
      originalDoc: { owner: 'u1', apiBaseUrl: 'https://api.example.com/v1', contacts: [{ type: 'wechat', value: 'owner-wechat', isPublic: false }], claimStatus: 'verified', status: 'approved', apiKeyEncrypted: 'enc:v1:fake' },
      req: { user: owner },
    })
    expect(result.status).toBe('draft')
    expect(result.claimStatus).toBe('unverified')
    expect(result.claimedAt).toBeNull()
    expect(result.claimToken).toBeTruthy()
  })
})

describe('relay API redaction and request origin', () => {
  it('hides private contacts, claim token and key metadata from public DTOs', () => {
    const site = {
      id: 's1', slug: 'relay-1', name: '站点', owner: { id: 'u1', username: 'owner' },
      websiteUrl: 'https://example.com', apiBaseUrl: 'https://api.example.com', description: '',
      contacts: [{ type: 'email', value: 'public@example.com', isPublic: true }, { type: 'wechat', value: 'private-id', isPublic: false }],
      protocol: 'openai', model: 'gpt-5.4', mode: 'standard', status: 'approved', claimStatus: 'verified',
      claimDomain: 'api.example.com', claimToken: 'top-secret-token', apiKeyEncrypted: 'enc:v1:secret', hasApiKey: true,
    }
    const publicDto = relaySiteDto(site) as any
    expect(publicDto.contacts).toHaveLength(1)
    expect(publicDto.claimToken).toBeUndefined()
    expect(publicDto.hasApiKey).toBeUndefined()
    expect(JSON.stringify(publicDto)).not.toContain('enc:v1')
    expect(JSON.stringify(publicDto)).not.toContain('private-id')

    const ownerDto = relaySiteDto(site, { id: 'u1', role: 'user', accountStatus: 'active' }) as any
    expect(ownerDto.contacts).toHaveLength(2)
    expect(ownerDto.claimToken).toBe('top-secret-token')
    expect(ownerDto.hasApiKey).toBe(true)
    expect(ownerDto.apiKeyEncrypted).toBeUndefined()
  })

  it('rejects cross-origin mutations while allowing same-origin and non-browser requests', () => {
    expect(sameOriginMutationAllowed(new Request('https://gewu.uk/v1/relay-sites', { headers: { Origin: 'https://evil.example' } }))).toBe(false)
    expect(sameOriginMutationAllowed(new Request('https://gewu.uk/v1/relay-sites', { headers: { Origin: 'https://gewu.uk' } }))).toBe(true)
    expect(sameOriginMutationAllowed(new Request('https://gewu.uk/v1/relay-sites'))).toBe(true)
  })
})
