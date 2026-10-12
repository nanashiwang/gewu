import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getMonitorHealth, type MonitorHealth } from '@/lib/monitorHealth'
import { MonitorHealthPanel } from '@/components/relay/MonitorHealthPanel'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('monitor health boundary', () => {
  it('fails closed without an internal token and does not call the detector', async () => {
    vi.stubEnv('GEWU_INTERNAL_API_TOKEN', '')
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await getMonitorHealth()).available).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses a header-only token without redirects, and hides error responses', async () => {
    vi.stubEnv('GEWU_INTERNAL_API_TOKEN', 'synthetic-internal-secret')
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.example')
    const fetcher = vi.fn().mockResolvedValue(new Response('private failure', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const result = await getMonitorHealth()
    expect(fetcher).toHaveBeenCalledWith('https://detector.example/api/status/monitor-health/summary', expect.objectContaining({ redirect: 'error', cache: 'no-store', headers: { 'X-Gewu-Internal-Token': 'synthetic-internal-secret' } }))
    expect(result).toEqual({ available: false, targets: [], summary: {} })
  })
  it('treats a malformed success body as unavailable', async () => {
    vi.stubEnv('GEWU_INTERNAL_API_TOKEN', 'synthetic-internal-secret')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ available: true, targets: [{ target_id: 'broken' }] })))
    expect((await getMonitorHealth()).available).toBe(false)
  })
  it('renders blocked, recovered and unavailable states without invented uptime', () => {
    const health: MonitorHealth = { available: true, summary: {}, targets: [{ target_id: 'synthetic-target', protocol: 'openai', model: 'gpt-test', mode: 'quick', failure_kind: 'authentication', label: '监测凭据鉴权失败', consecutive_failures: 12, last_attempt_at: '2026-10-12T00:00:00Z', last_valid_at: null, next_attempt_at: '2026-10-13T00:00:00Z', last_report_id: null, cooling: true }] }
    const blocked = renderToStaticMarkup(createElement(MonitorHealthPanel, { health }))
    expect(blocked).toContain('12 次'); expect(blocked).toContain('冷却中'); expect(blocked).toContain('暂无记录')
    expect(blocked).not.toContain('100%')
    health.targets[0] = { ...health.targets[0], failure_kind: 'valid', label: '已取得有效检测证据', consecutive_failures: 0, cooling: false, next_attempt_at: null, last_valid_at: '2026-10-12T01:00:00Z' }
    const good = renderToStaticMarkup(createElement(MonitorHealthPanel, { health }))
    expect(good).toContain('已取得有效检测证据'); expect(good).not.toContain('冷却中')
    const absent = renderToStaticMarkup(createElement(MonitorHealthPanel, { health: { available: false, summary: {}, targets: [] } }))
    expect(absent).toContain('暂时无法读取监测状态')
  })
})
