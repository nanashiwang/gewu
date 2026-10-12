import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret } from '@/lib/secrets'
import { cancelRelayCheck, reconcileRelayCheck, startRelayCheck } from '@/lib/relayDetection'

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
  it.each(['cancelled', 'interrupted'])('retains partial evidence for %s without updating a site score', async (status) => {
    vi.stubEnv('PAYLOAD_SECRET', TEST_SECRET)
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.example')
    const writes: any[] = []
    const payload: any = {
      findByID: vi.fn(async () => encryptedSite()),
      update: vi.fn(async (args) => { writes.push(args); return args.data }),
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/api/status/')
      ? { status, error: '任务已中断', result_url: '/r/job_12345678', finished_at: 123 }
      : { run_error: 'interrupted', results: [{ details: { response_text: 'sk-private-relay-key' } }] }))))
    const check = await reconcileRelayCheck(payload, { id: 'check-1', site: 'site-1', status: 'running', detectorJobId: 'job_12345678' })
    expect(check.status).toBe('error')
    expect(check.score).toBeNull()
    expect(check.report).toBeTruthy()
    expect(writes).toHaveLength(1)
    expect(writes[0].collection).toBe('relay-checks')
    expect(JSON.stringify(writes)).not.toContain('sk-private-relay-key')
  })

  it('cannot cancel a check belonging to a different site', async () => {
    const payload: any = { findByID: vi.fn(async () => ({ id: 'check-1', site: 'other-site', status: 'running' })) }
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(cancelRelayCheck(payload, 'site-1', 'check-1')).rejects.toThrow('无权操作')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not mark a submitting check cancelled without an upstream job id', async () => {
    const payload: any = { findByID: vi.fn(async () => ({ id: 'check-1', site: 'site-1', status: 'queued' })) }
    await expect(cancelRelayCheck(payload, 'site-1', 'check-1')).rejects.toThrow('正在提交')
  })

  it('authenticates cancellation and reconciles the exact selected check', async () => {
    vi.stubEnv('GEWU_INTERNAL_API_TOKEN', 'internal-test-token')
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.example')
    const check = { id: 'check-1', site: 'site-1', status: 'running', detectorJobId: 'job_12345678' }
    const payload: any = {
      findByID: vi.fn(async ({ collection }) => collection === 'relay-checks' ? check : null),
      update: vi.fn(async ({ data }) => data),
    }
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ status: 'cancelled', error: '你已取消本次检测' })))
    vi.stubGlobal('fetch', fetcher)
    expect((await cancelRelayCheck(payload, 'site-1', 'check-1')).status).toBe('error')
    expect(fetcher.mock.calls[0][0]).toBe('https://detector.example/api/status/job_12345678/cancel')
    expect(fetcher.mock.calls[0][1].method).toBe('POST')
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('X-Gewu-Internal-Token')).toBe('internal-test-token')
  })
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
        results: [{ name: 'basic_request', status: 'pass' }],
        verdict: 'trusted sk-private-relay-key',
        summary: '通过 sk-private-relay-key',
        nested: { reflected: 'sk-private-relay-key' },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result: any = await reconcileRelayCheck(payload, {
      id: 'check-1', site: 'site-1', detectorJobId: 'job_12345678', createdAt: '2026-07-18T11:00:00.000Z',
      protocol: 'openai', model: 'gpt-5.4', mode: 'standard',
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

  it.each([
    { run_error: 'quota sk-private-relay-key', results: [{ name: 'basic_request', status: 'pass' }] },
    { results: [{ name: 'basic_request', status: 'error' }], assessment: { score_usable: true } },
    { results: [{ name: 'basic_request', status: 'pass' }, { name: 'streaming', status: 'error' }] },
    { results: [] },
  ])('keeps incomplete reports out of station scores and preserves a redacted report link (%j)', async (partial) => {
    vi.stubEnv('PAYLOAD_SECRET', TEST_SECRET)
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.internal')
    const updates: any[] = []
    const payload: any = {
      findByID: vi.fn(async () => encryptedSite()),
      update: vi.fn(async (args: any) => { updates.push(args); return { id: args.id, ...args.data } }),
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'done' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_score: 100, verdict: 'passed', ...partial }))))
    const result: any = await reconcileRelayCheck(payload, {
      id: 'check-1', site: 'site-1', protocol: 'openai', detectorJobId: 'job_12345678', createdAt: new Date().toISOString(),
    })
    expect(result.status).toBe('error')
    expect(result.score).toBeNull()
    expect(result.resultUrl).toContain('/r/job_12345678')
    expect(JSON.stringify(result)).not.toContain('sk-private-relay-key')
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
