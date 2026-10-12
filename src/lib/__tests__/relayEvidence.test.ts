import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RelayTrend } from '@/components/relay/RelayTrend'
import { RelaySteps } from '@/components/relay/RelaySteps'
import { initialModelSelection, isRelayCatalogStale, relayModelCatalog, relayVendors } from '@/lib/relayModelCatalog'
import { relayCheckHasScore, relayReportPath } from '@/lib/relayUi'
import { reportHasUsableEvidence } from '@/lib/relayEvidence'
import { sameRelayScoreBasis } from '@/lib/relayWireApi'

const currentReport = () => ({ scoring_version: 'evidence-v2', probe_version: 'calibration-1', total_score: 100,
  results: [{ name: 'identity', status: 'fail', score: 0, weight: 0, evidence_role: 'observation', details: { core_response_valid: true } },
    { name: 'consistency', status: 'pass', score: 100, weight: 10, evidence_role: 'scored' }] })

describe('relay account evidence and selection', () => {
  it('accepts completed evidence despite an unconvincing self-claim and rejects unknown policies', () => {
    expect(reportHasUsableEvidence(currentReport(), 'anthropic')).toBe(true)
    expect(reportHasUsableEvidence({ ...currentReport(), scoring_version: 'future-v999' }, 'anthropic')).toBe(false)
  })
  it.each(['self_only', 'skipped', 'core_missing', 'weighted_observation', 'hidden_capability', 'forged_total', 'missing_probe', 'duplicate'])('rejects %s evidence even with a forged successful assessment', (scenario) => {
    const report: any = { ...currentReport(), assessment: { score_usable: true } }
    if (scenario === 'self_only') report.results.pop()
    if (scenario === 'skipped') report.results[1].status = 'skip'
    if (scenario === 'core_missing') report.results[0].details = {}
    if (scenario === 'weighted_observation') report.results[0].weight = 5
    if (scenario === 'hidden_capability') report.results[1].evidence_role = 'observation'
    if (scenario === 'forged_total') report.total_score = 80
    if (scenario === 'missing_probe') delete report.probe_version
    if (scenario === 'duplicate') report.results.push({ ...report.results[1] })
    expect(reportHasUsableEvidence(report, 'anthropic')).toBe(false)
  })
  it('isolates scoring and probe versions and picks the newest record independent of input order', () => {
    const current = { id: 'current', protocol: 'anthropic', model: 'claude-fixture', mode: 'full', status: 'done', score: 100, report: currentReport(), createdAt: '2026-10-12T02:00:00Z' }
    const legacy = { ...current, id: 'legacy', report: { results: [{ name: 'identity', status: 'pass' }] }, score: 55, createdAt: '2026-10-12T00:00:00Z' }
    const oldProbe = { ...current, id: 'old-probe', report: { ...currentReport(), probe_version: 'old' }, createdAt: '2026-10-12T01:00:00Z' }
    expect(sameRelayScoreBasis(current, legacy)).toBe(false)
    expect(sameRelayScoreBasis(current, oldProbe)).toBe(false)
    expect(sameRelayScoreBasis(current, current)).toBe(true)
    const html = renderToStaticMarkup(createElement(RelayTrend, { checks: [legacy, oldProbe, current] }))
    expect(html).toContain('最近 1 次有效检测')
    expect(html).toContain('历史评分 v1')
    expect(html).toContain('证据评分 v2')
    expect(html).toContain('55 分')
  })
  it('uses UTC review dates and warns only after the review interval has elapsed', () => {
    const reviewed = Date.parse(`${relayModelCatalog.verified_on}T00:00:00Z`)
    expect(isRelayCatalogStale(new Date(reviewed + relayModelCatalog.review_interval_days * 86_400_000 + 86_399_999))).toBe(false)
    expect(isRelayCatalogStale(new Date(reviewed + (relayModelCatalog.review_interval_days + 1) * 86_400_000))).toBe(true)
  })
  it('preserves an existing alias and its protocol instead of substituting a catalog model', () => {
    expect(initialModelSelection('provider/private-alias', 'anthropic')).toEqual({ vendor: 'other', model: 'provider/private-alias', protocol: 'anthropic' })
    const model = relayModelCatalog.vendors[0].models[0]
    expect(initialModelSelection(model, 'openai')).toEqual({ vendor: 'anthropic', model, protocol: 'openai' })
    expect(relayVendors.filter(v => v.source).length).toBe(9)
  })
  it('renders failure and pending history even when no successful check exists', () => {
    const html = renderToStaticMarkup(createElement(RelayTrend, { checks: [
      { id: '1', status: 'error', error: '连接超时，请复测', model: 'private-alias', createdAt: '2026-10-12T00:00:00Z' },
      { id: '2', status: 'queued', model: 'private-alias', detectorJobId: 'job_12345678', createdAt: '2026-10-12T00:00:00Z' },
    ] }))
    expect(html).toContain('连接超时，请复测')
    expect(html).toContain('排队中')
    expect(html).toContain('/r/job_12345678')
    expect(html).not.toContain('NaN')
  })
  it('does not promote a 100 score or forged assessment over failed evidence', () => {
    const report = { assessment: { score_usable: true }, results: [{ name: 'basic_request', status: 'error' }] }
    expect(reportHasUsableEvidence(report, 'openai')).toBe(false)
    expect(relayCheckHasScore({ status: 'done', score: 100, protocol: 'openai', report })).toBe(false)
    expect(reportHasUsableEvidence({ results: [{ name: 'basic_request', status: 'pass' }], run_error: 'quota' }, 'openai')).toBe(false)
  })
  it('links only to same-site report paths and rejects injected URL schemes', () => {
    expect(relayReportPath({ resultUrl: 'javascript:alert(1)' })).toBeNull()
    expect(relayReportPath({ resultUrl: 'https://external.example/r/job_12345678' })).toBe('/r/job_12345678')
  })
  it('rejects historical auth failures without reading model self-description as a transport error', () => {
    const core = { name: 'basic_request', status: 'pass' }
    expect(reportHasUsableEvidence({ results: [{ ...core, details: { upstream: { status_code: 401 } } }] }, 'openai')).toBe(false)
    expect(reportHasUsableEvidence({ results: [{ ...core, details: { response_text: 'I am model 401' } }] }, 'openai')).toBe(true)
    expect(reportHasUsableEvidence({ results: [{ ...core, error: 'timeout' }] }, 'openai')).toBe(false)
  })
  it('makes pending review and suspended status explicit', () => {
    const html = renderToStaticMarkup(createElement(RelaySteps, { site: { claimStatus: 'verified', status: 'pending' } }))
    expect(html).toContain('等待人工审核')
    expect(html).toContain('aria-current="step"')
    expect(renderToStaticMarkup(createElement(RelaySteps, { site: { claimStatus: 'verified', status: 'suspended' } }))).toContain('联系运营复核')
  })
})
