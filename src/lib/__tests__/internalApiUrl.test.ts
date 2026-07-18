import { afterEach, describe, expect, it, vi } from 'vitest'
import { internalApiUrl } from '@/lib/internalApiUrl'

describe('internal API URL', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses the explicit loopback origin in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PORT', '3000')
    expect(internalApiUrl('/api/users/login', 'https://gewu.uk/v1/auth/login')).toBe(
      'http://127.0.0.1:3000/api/users/login',
    )
  })

  it('supports an explicit internal origin and rejects credential-bearing values', () => {
    vi.stubEnv('INTERNAL_SERVER_URL', 'http://app:3000')
    expect(internalApiUrl('/api/users/login', 'https://gewu.uk/v1/auth/login')).toBe(
      'http://app:3000/api/users/login',
    )
    vi.stubEnv('INTERNAL_SERVER_URL', 'http://user:pass@app:3000')
    expect(() => internalApiUrl('/api/users/login', 'https://gewu.uk/v1/auth/login')).toThrow('配置无效')
  })
})