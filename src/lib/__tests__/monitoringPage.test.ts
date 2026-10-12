import { beforeEach, describe, expect, it, vi } from 'vitest'

const { user, health, absent } = vi.hoisted(() => ({ user: vi.fn(), health: vi.fn(), absent: vi.fn(() => { throw new Error('NOT_FOUND') }) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: user }))
vi.mock('@/lib/monitorHealth', () => ({ getMonitorHealth: health }))
vi.mock('next/navigation', () => ({ notFound: absent }))
import MonitoringPage from '@/app/(frontend)/console/relays/monitoring/page'

beforeEach(() => { vi.clearAllMocks(); health.mockResolvedValue({ available: true, targets: [], summary: {} }) })
describe('monitoring page authorization', () => {
  it.each([null, { id: '1', role: 'user' }, { id: '1', role: 'admin', accountStatus: 'banned' }, { id: '1', role: 'enterprise_admin' }])('rejects unauthorized accounts before fetching private evidence: %s', async account => {
    user.mockResolvedValue(account)
    await expect(MonitoringPage()).rejects.toThrow('NOT_FOUND')
    expect(health).not.toHaveBeenCalled()
  })
  it.each(['admin', 'reviewer'])('permits an active %s', async role => {
    user.mockResolvedValue({ id: '1', role })
    await MonitoringPage()
    expect(health).toHaveBeenCalledOnce()
  })
})
