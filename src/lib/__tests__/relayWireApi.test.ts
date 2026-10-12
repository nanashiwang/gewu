import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelaySites } from '@/collections/RelaySites'
import { resolveRelayWireApi, sameRelayConfiguration } from '@/lib/relayWireApi'
import { normalizeRelaySiteInput } from '@/lib/relaySite'
import { startRelayCheck, reconcileRelayCheck } from '@/lib/relayDetection'
import { encryptSecret } from '@/lib/secrets'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function site(wireApi: string | null = 'interactions') {
  vi.stubEnv('PAYLOAD_SECRET', 'synthetic-relay-secret-with-32-bytes')
  vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.example')
  return { id: 'site-1', protocol: 'gemini', model: 'gemini-fixture', mode: 'standard', wireApi,
    apiBaseUrl: 'https://relay.example/v1beta', apiKeyEncrypted: encryptSecret('synthetic-key') }
}

describe('explicit interface contracts', () => {
  it.each([['openai', 'chat_completions'], ['gemini', 'chat_completions'], ['anthropic', 'messages']])('preserves legacy %s schedules', (protocol, api) => {
    expect(resolveRelayWireApi(protocol)).toBe(api)
    expect(resolveRelayWireApi(protocol, null)).toBe(api)
  })

  it.each([['gemini', 'responses'], ['openai', 'interactions'], ['anthropic', 'chat_completions'], ['gemini', 'unknown']])('rejects incompatible %s / %s', (protocol, wireApi) => {
    expect(() => normalizeRelaySiteInput({ protocol, wireApi }, { partial: true })).toThrow()
  })

  it('checks protocol-only updates against the stored interface', () => {
    const hook = RelaySites.hooks!.beforeValidate![0] as any
    expect(() => hook({ operation: 'update', req: { user: { id: 'u1', role: 'admin', status: 'active' } },
      originalDoc: { ...site(), contacts: [{ type: 'email', value: 'owner@example.com' }] }, data: { protocol: 'openai' } })).toThrow('检测协议与接口类型不匹配')
  })

  it('does not compare model, API or depth changes as one series', () => {
    const original = site()
    expect(sameRelayConfiguration(original, { ...original })).toBe(true)
    for (const change of [{ model: 'other' }, { wireApi: 'generate_content' }, { mode: 'full' }]) {
      expect(sameRelayConfiguration(original, { ...original, ...change })).toBe(false)
    }
  })

  it.each(['manual', 'scheduled'] as const)('snapshots and submits identical native settings for %s checks', async (source) => {
    const target = site()
    let snapshot: any
    const payload: any = { count: vi.fn(async () => ({ totalDocs: 0 })),
      create: vi.fn(async ({ data }) => { snapshot = data; return { id: 'check-1', ...data } }),
      update: vi.fn(async ({ data }) => data) }
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const form = options.body as FormData
      expect(form.get('wire_api')).toBe(snapshot.wireApi)
      expect(form.get('api_key')).toBe('synthetic-key')
      return new Response(JSON.stringify({ job_id: 'job_fixture_123' }))
    })
    vi.stubGlobal('fetch', fetcher)
    await startRelayCheck(payload, target, { source })
    expect(snapshot).toMatchObject({ protocol: 'gemini', wireApi: 'interactions', source })
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-key')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['wrong_api', 'missing_api', 'wrong_protocol', 'missing_protocol', 'wrong_model', 'missing_model', 'wrong_mode', 'missing_mode', 'changed_site'])('handles %s without overwriting current score', async (scenario) => {
    const target = site(scenario === 'changed_site' ? 'generate_content' : 'interactions')
    const check = { id: 'check-1', site: 'site-1', detectorJobId: 'job_fixture_123', createdAt: new Date().toISOString(),
      protocol: 'gemini', model: 'gemini-fixture', mode: 'standard', wireApi: 'interactions' }
    const report: any = { protocol: 'gemini', wire_api: 'interactions', target_model: check.model, mode: check.mode,
      total_score: 100, results: [{ name: 'basic_request', status: 'pass' }], verdict: 'passed' }
    if (scenario === 'wrong_api') report.wire_api = 'generate_content'
    if (scenario === 'missing_api') delete report.wire_api
    if (scenario === 'wrong_protocol') report.protocol = 'openai'
    if (scenario === 'wrong_model') report.target_model = 'other'
    if (scenario === 'wrong_mode') report.mode = 'quick'
    if (scenario === 'missing_protocol') delete report.protocol
    if (scenario === 'missing_model') delete report.target_model
    if (scenario === 'missing_mode') delete report.mode
    const writes: any[] = []
    const payload: any = { findByID: vi.fn(async () => target), update: vi.fn(async (args) => { writes.push(args); return args.data }) }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/api/status/') ? { status: 'done' } : report))))
    const result: any = await reconcileRelayCheck(payload, check)
    expect(result.status).toBe(scenario === 'changed_site' ? 'done' : 'error')
    if (scenario !== 'changed_site') expect(result.error).toContain('不匹配')
    expect(writes).toHaveLength(1)
    expect(writes[0].collection).toBe('relay-checks')
  })
})
