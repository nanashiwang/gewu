import { afterEach, describe, expect, it, vi } from 'vitest'
import { openRelayReport } from '@/lib/relayDetection'
import { relayReportPath } from '@/lib/relayUi'
import { relayCheckDto } from '@/lib/relayApi'

const owner = 'a'.repeat(43)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('account report capability bridge', () => {
  it('refuses a check from another site before contacting the detector', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const payload: any = { findByID: vi.fn(async () => ({ site: 'other-site', detectorJobId: 'privatejob123' })) }
    await expect(openRelayReport(payload, 'mine', 'check-1')).rejects.toThrow('不属于')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires internal authentication and rejects missing or malformed jobs', async () => {
    const payload: any = { findByID: vi.fn(async () => ({ site: 'mine', detectorJobId: '../../secret' })) }
    await expect(openRelayReport(payload, 'mine', 'check-1')).rejects.toThrow('尚未开始')
    payload.findByID.mockResolvedValue({ site: 'mine', detectorJobId: 'privatejob123' })
    vi.stubEnv('GEWU_INTERNAL_API_TOKEN', '')
    await expect(openRelayReport(payload, 'mine', 'check-1')).rejects.toThrow('尚未配置')
  })

  it('fetches one report capability without persisting it or using a query string', async () => {
    vi.stubEnv('DETECTOR_BASE_URL', 'https://detector.example')
    vi.stubEnv('GEWU_INTERNAL_API_TOKEN', 'synthetic-internal')
    const payload: any = { findByID: vi.fn(async () => ({ site: { id: 'mine' }, detectorJobId: 'privatejob123' })), update: vi.fn() }
    const fetcher = vi.fn(async () => Response.json({ owner }))
    vi.stubGlobal('fetch', fetcher)
    expect(await openRelayReport(payload, 'mine', 'check-1')).toEqual({ jobId: 'privatejob123', owner })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://detector.example/api/status/privatejob123/owner')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('X-Gewu-Internal-Token')).toBe('synthetic-internal')
    expect(payload.update).not.toHaveBeenCalled()
  })

  it('accepts legacy reports, rejects malformed grants, and hides private public links', async () => {
    vi.stubEnv('GEWU_INTERNAL_API_TOKEN', 'synthetic-internal')
    const payload: any = { findByID: vi.fn(async () => ({ site: 'mine', detectorJobId: 'privatejob123' })) }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ legacy: true })))
    expect((await openRelayReport(payload, 'mine', 'check-1')).owner).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ owner: 'bad\nvalue' })))
    await expect(openRelayReport(payload, 'mine', 'check-1')).rejects.toThrow('无效')
    expect(relayReportPath({ detectorJobId: 'privatejob123', reportPrivate: true })).toBeNull()
    expect(relayReportPath({ detectorJobId: 'privatejob123', report: { _web_access: 1 } })).toBeNull()
    expect(relayReportPath({ detectorJobId: 'legacyjob123' })).toBe('/r/legacyjob123')
  })
})


it('public account history cannot expose private report IDs, raw summaries or URLs', () => {
  const record = { id: 'check-1', status: 'done', detectorJobId: 'privatejob123', resultUrl: '/r/privatejob123',
    summary: 'synthetic-private-response', report: { _web_access: 1, privateEvidence: 'synthetic-evidence' } }
  const publicView = relayCheckDto(record)
  expect(publicView.reportPrivate).toBe(true)
  expect(publicView.resultUrl).toBeNull()
  expect(publicView.detectorJobId).toBeNull()
  expect(publicView.summary).toBe('')
  expect(publicView.report).toBeUndefined()
  expect(JSON.stringify(publicView)).not.toContain('synthetic-private-response')
  const mine = relayCheckDto(record, true)
  expect(mine.detectorJobId).toBe('privatejob123')
  expect(mine.report).toEqual(record.report)
  expect(mine.summary).toBe(record.summary)
})
