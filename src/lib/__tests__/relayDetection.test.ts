import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret } from '@/lib/secrets'
import { reconcileRelayCheck, startRelayCheck } from '@/lib/relayDetection'

const TEST_SECRET = 'relay-detection-test-secret-32-bytes'

function encryptedSite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'site-1',
    apiBaseUrl: 'https://api.example.com/v1',
    protocol: 'openai',
    model: 'gpt-5.4',
    mode: 'standard',
    apiKeyEncrypted: encryptSecret('sk-private-relay-key'),
    ...overrides,
  }
}

describe('relay detection bridge', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('submits the decrypted key only to the detector and never persists plaintext', async () => {
    vi.stubEnv('PAYLOAD_SECRET', TEST_SECRET)
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.example')
    const writes: any[] = []
    const payload: any = {
      count: vi.fn(async () => ({ totalDocs: 0 })),
      create: vi.fn(async ({ data }: any) => ({ id: 'check-1', ...data })),
      update: vi.fn(async ({ id, data }: any) => {
        writes.push({ id, data })
        return { id, ...data }
      }),
    }
    let submittedForm: FormData | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      submittedForm = init.body as FormData
      return new Response(JSON.stringify({ job_id: 'job_12345678' }), { status: 200 })
    }))

    const result = await startRelayCheck(payload, encryptedSite(), { source: 'manual', userId: 'u1' })
    expect((submittedForm as FormData | null)?.get('api_key')).toBe('sk-private-relay-key')
    expect((submittedForm as FormData | null)?.get('base_url')).toBe('https://api.example.com/v1')
    expect(result.detectorJobId).toBe('job_12345678')
    expect(JSON.stringify(writes)).not.toContain('sk-private-relay-key')
  })

  it('redacts a reflected key from detector submission errors before persistence', async () => {
    vi.stubEnv('PAYLOAD_SECRET', TEST_SECRET)
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.example')
    const writes: any[] = []
    const payload: any = {
      count: vi.fn(async () => ({ totalDocs: 0 })),
      create: vi.fn(async ({ data }: any) => ({ id: 'check-1', ...data })),
      update: vi.fn(async ({ data }: any) => {
        writes.push(data)
        return data
      }),
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'upstream echoed sk-private-relay-key' }),
      { status: 502 },
    )))

    await expect(startRelayCheck(payload, encryptedSite(), { source: 'manual' })).rejects.toThrow()
    expect(JSON.stringify(writes)).not.toContain('sk-private-relay-key')
    expect(writes.at(-1)?.error).toContain('[REDACTED]')
  })

  it('prevents overlapping checks for the same site before submission', async () => {
    const payload: any = { count: vi.fn(async () => ({ totalDocs: 1 })) }
    await expect(startRelayCheck(payload, { id: 'site-1' }, { source: 'manual' })).rejects.toThrow('正在运行')
  })

  it('maps the database active-check uniqueness guard to a stable conflict', async () => {
    vi.stubEnv('PAYLOAD_SECRET', TEST_SECRET)
    const conflict: any = new Error('duplicate key relay_checks_one_active_per_site_idx')
    conflict.code = '23505'
    const payload: any = {
      count: vi.fn(async () => ({ totalDocs: 0 })),
      create: vi.fn(async () => { throw conflict }),
    }
    await expect(startRelayCheck(payload, encryptedSite(), { source: 'manual' })).rejects.toThrow('正在运行')
  })

  it('reconciles a valid report, redacts reflected secrets, and updates the site summary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    vi.stubEnv('PAYLOAD_SECRET', TEST_SECRET)
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.internal')
    vi.stubEnv('DETECTOR_PUBLIC_URL', 'https://gewu.uk')
    const updates: any[] = []
    const payload: any = {
      findByID: vi.fn(async () => encryptedSite()),
      update: vi.fn(async (args: any) => {
        updates.push(args)
        return { id: args.id, ...args.data }
      }),
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job_id: 'job_12345678', status: 'done', started_at: 1_752_796_800, finished_at: 1_752_796_812,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        total_score: 98,
        verdict: 'trusted sk-private-relay-key',
        summary: '通过 sk-private-relay-key',
        nested: { reflected: 'sk-private-relay-key' },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result: any = await reconcileRelayCheck(payload, {
      id: 'check-1', site: 'site-1', detectorJobId: 'job_12345678', createdAt: '2026-07-18T11:00:00.000Z',
    })
    expect(result.score).toBe(98)
    expect(result.grade).toBe('A')
    expect(result.resultUrl).toBe('https://gewu.uk/r/job_12345678')
    expect(JSON.stringify(result)).not.toContain('sk-private-relay-key')
    expect(result.report.nested.reflected).toBe('[REDACTED]')
    expect(updates[1].collection).toBe('relay-sites')
    expect(updates[1].data).toMatchObject({ lastScore: 98, lastGrade: 'A', lastVerdict: 'trusted [REDACTED]' })
  })

  it('rejects an out-of-contract score instead of silently clamping it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    vi.stubEnv('PAYLOAD_SECRET', TEST_SECRET)
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.internal')
    const updates: any[] = []
    const payload: any = {
      findByID: vi.fn(async () => encryptedSite()),
      update: vi.fn(async (args: any) => {
        updates.push(args)
        return { id: args.id, ...args.data }
      }),
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'done' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_score: 105 }), { status: 200 })))

    const result: any = await reconcileRelayCheck(payload, {
      id: 'check-1', site: 'site-1', detectorJobId: 'job_12345678', createdAt: '2026-07-18T11:00:00.000Z',
    })
    expect(result.status).toBe('error')
    expect(result.error).toContain('得分无效')
    expect(updates.some((update) => update.collection === 'relay-sites')).toBe(false)
  })

  it('expires interrupted submissions and overlong jobs so they cannot block future checks forever', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    const updates: any[] = []
    const payload: any = {
      update: vi.fn(async (args: any) => {
        updates.push(args)
        return { id: args.id, ...args.data }
      }),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const interrupted: any = await reconcileRelayCheck(payload, {
      id: 'check-stale', site: 'site-1', status: 'queued', createdAt: '2026-07-18T11:54:59.000Z',
    })
    const overlong: any = await reconcileRelayCheck(payload, {
      id: 'check-long', site: 'site-1', status: 'running', detectorJobId: 'job_12345678', createdAt: '2026-07-18T05:59:59.000Z',
    })

    expect(interrupted.status).toBe('error')
    expect(interrupted.error).toContain('提交中断')
    expect(overlong.status).toBe('error')
    expect(overlong.error).toContain('最大执行时间')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})