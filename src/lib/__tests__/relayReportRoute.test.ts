import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ actor: vi.fn(), find: vi.fn(), grant: vi.fn() }))
vi.mock('@/lib/relayApi', () => ({
  relayActor: mock.actor, findRelayForActor: mock.find,
  isRelayActorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/relayDetection', () => ({ openRelayReport: mock.grant }))
import { GET } from '@/app/v1/relay-sites/[id]/checks/[checkId]/report/route'

const sessionHeaders = () => ({ Cookie: 'payload-token=fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url') + '.signature' })
const request = () => new Request('https://gewu.example/v1/relay-sites/mine/checks/check-1/report', { headers: sessionHeaders() })
const params = () => ({ params: Promise.resolve({ id: 'mine', checkId: 'check-1' }) })

beforeEach(() => vi.stubEnv('GEWU_INTERNAL_API_TOKEN', 'synthetic-session-key'))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })

describe('authorized account report redirect', () => {
  it('requires login and site ownership before requesting any report capability', async () => {
    mock.actor.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await GET(request(), params())).status).toBe(401)
    expect(mock.grant).not.toHaveBeenCalled()
    mock.actor.mockResolvedValue({ payload: {}, user: { id: 'other-user' } })
    mock.find.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    expect((await GET(request(), params())).status).toBe(403)
    expect(mock.grant).not.toHaveBeenCalled()
  })

  it('places the report capability only in a secure HttpOnly cookie', async () => {
    mock.actor.mockResolvedValue({ payload: {}, user: { id: 'owner' } })
    mock.find.mockResolvedValue({ site: { id: 'mine' } })
    const owner = 'z'.repeat(43)
    mock.grant.mockResolvedValue({ jobId: 'privatejob123', owner })
    const response = await GET(request(), params())
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/r/privatejob123')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const cookie = response.headers.get('set-cookie') || ''
    for (const value of ['__Host-' + 'gewu_report_' + 'privatejob123=' , owner, 'HttpOnly', 'Secure', 'SameSite=lax', 'Path=/']) expect(cookie).toContain(value)
    expect(cookie).not.toContain('Domain=')
    expect(await response.text()).not.toContain(owner)
    expect(response.headers.get('location')).not.toContain(owner)
    expect(mock.grant).toHaveBeenCalledWith({}, 'mine', 'check-1')
  })

  it('keeps legacy URLs usable and fails without leaking detector errors', async () => {
    mock.actor.mockResolvedValue({ payload: {}, user: { id: 'owner' } })
    mock.find.mockResolvedValue({ site: { id: 'mine' } })
    mock.grant.mockResolvedValue({ jobId: 'legacyjob123', owner: null })
    const old = await GET(request(), params())
    expect(old.status).toBe(303)
    expect(old.headers.has('set-cookie')).toBe(false)
    mock.grant.mockRejectedValue(new Error('synthetic-internal-secret'))
    const failed = await GET(request(), params())
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('synthetic-internal-secret')
  })
})


it('keeps production grant cookies Secure behind a TLS reverse proxy', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  mock.actor.mockResolvedValue({ payload: {}, user: { id: 'owner' } })
  mock.find.mockResolvedValue({ site: { id: 'mine' } })
  mock.grant.mockResolvedValue({ jobId: 'privatejob123', owner: 'a'.repeat(43) })
  const response = await GET(new Request('http://internal-app/v1/relay-sites/mine/checks/check-1/report', { headers: sessionHeaders() }), params())
  expect(response.headers.get('set-cookie')).toContain('Secure')
  expect(response.headers.get('set-cookie')).toContain('__Host-')
})
