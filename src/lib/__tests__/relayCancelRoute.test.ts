import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ actor: vi.fn(), limited: vi.fn(), find: vi.fn(), cancel: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/relayApi', () => ({
  relayActor: mocks.actor, enforceRelayRateLimit: mocks.limited, findRelayForActor: mocks.find,
  isRelayActorResponse: (value: unknown) => value instanceof Response,
  relayCheckDto: (value: unknown) => value,
}))
vi.mock('@/lib/relayDetection', () => ({ cancelRelayCheck: mocks.cancel }))
vi.mock('@/lib/audit', () => ({ recordAuditEvent: mocks.audit }))
import { POST } from '@/app/v1/relay-sites/[id]/cancel-check/route'

describe('station cancellation authorization boundary', () => {
  beforeEach(() => {
    mocks.actor.mockResolvedValue({ payload: {}, user: { id: 'owner' } })
    mocks.limited.mockResolvedValue(null)
    mocks.find.mockResolvedValue({ site: { id: 'site-1', name: '模拟站点' } })
    mocks.cancel.mockResolvedValue({ id: 'check-1', status: 'error' })
  })
  afterEach(() => vi.resetAllMocks())
  const request = (body = JSON.stringify({ checkId: 'check-1' })) => new Request('https://gewu.uk/v1/relay-sites/site-1/cancel-check', { method: 'POST', body })
  const params = () => ({ params: Promise.resolve({ id: 'site-1' }) })
  it('rejects unauthenticated users before resolving a task', async () => {
    mocks.actor.mockResolvedValue(new Response('', { status: 401 }))
    expect((await POST(request(), params())).status).toBe(401)
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it('rejects another site owner without reaching the detector', async () => {
    mocks.find.mockResolvedValue({ error: new Response('', { status: 403 }) })
    expect((await POST(request(), params())).status).toBe(403)
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it('bounds the cancellation request body', async () => {
    expect((await POST(request('x'.repeat(1025)), params())).status).toBe(413)
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it('cancels only the exact task requested and records the outcome', async () => {
    expect((await POST(request(), params())).status).toBe(200)
    expect(mocks.cancel).toHaveBeenCalledWith({}, 'site-1', 'check-1')
    expect(mocks.audit).toHaveBeenCalledWith({}, expect.objectContaining({ event: 'relay_check_cancelled' }))
  })
})
