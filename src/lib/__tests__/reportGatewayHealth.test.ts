import { afterEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ count: vi.fn() }))
vi.mock('payload', () => ({ getPayload: async () => ({ count: mock.count }) }))
vi.mock('@payload-config', () => ({ default: {} }))
import { GET } from '@/app/health/route'

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })

it.each(['', 'synthetic-shared-service-key'])('advertises the account report gateway only with internal authentication configured', async (token) => {
  vi.stubEnv('GEWU_INTERNAL_API_TOKEN', token)
  mock.count.mockResolvedValue({ totalDocs: 0 })
  const response = await GET()
  const body = await response.json()
  expect(response.status).toBe(200)
  expect(body.features.reportOwnerGateway).toBe(token ? 1 : 0)
  if (token) expect(JSON.stringify(body)).not.toContain(token)
})
