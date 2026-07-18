import { describe, expect, it } from 'vitest'
import { FIRST_PARTY_RELAY_SNAPSHOT, VERIDROP_RELAY_SNAPSHOT } from '@/lib/relaySnapshots'

const normalizeDomain = (domain: string) => domain.trim().toLowerCase().replace(/\.$/, '')

const listedSites = [
  ...VERIDROP_RELAY_SNAPSHOT.referenceSites,
  ...VERIDROP_RELAY_SNAPSHOT.riskSites,
]

const allSnapshotEntries = [
  ...listedSites,
  ...VERIDROP_RELAY_SNAPSHOT.insufficientEvidence,
]

describe('relay comparison snapshots', () => {
  it('excludes source ranks 1-10 and accounts for every captured rank from 11-33', () => {
    expect(VERIDROP_RELAY_SNAPSHOT.excludedTopRanks).toEqual({ from: 1, to: 10, count: 10 })
    expect(allSnapshotEntries.map((site) => site.sourceRank).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 11),
    )
    expect(allSnapshotEntries.every((site) => site.sourceRank > 10)).toBe(true)
  })

  it('uses unique normalized relay domains and excludes official model-provider APIs', () => {
    const domains = allSnapshotEntries.map((site) => normalizeDomain(site.domain))
    expect(new Set(domains).size).toBe(domains.length)

    const officialDomains = new Set([
      'api.anthropic.com',
      'api.openai.com',
      'generativelanguage.googleapis.com',
    ])
    expect(domains.some((domain) => officialDomains.has(domain))).toBe(false)
  })

  it('derives risk observations only when both score and evidence thresholds are met', () => {
    const { sourceScoreBelow, minimumReportCount } = VERIDROP_RELAY_SNAPSHOT.riskThreshold
    expect(VERIDROP_RELAY_SNAPSHOT.riskSites.map((site) => site.domain)).toEqual([
      'quotarouter.ai',
      'codexpp.com',
      'lucisapi.ai',
    ])

    for (const site of VERIDROP_RELAY_SNAPSHOT.riskSites) {
      expect(site.sourceScore).toBeLessThan(sourceScoreBelow)
      expect(site.reportCount).toBeGreaterThanOrEqual(minimumReportCount)
    }

    expect(VERIDROP_RELAY_SNAPSHOT.referenceSites.every((site) => site.sourceScore >= 70)).toBe(true)
    expect(VERIDROP_RELAY_SNAPSHOT.riskSites.some((site) => site.domain === 'ai.fengl.cc')).toBe(false)
    expect(VERIDROP_RELAY_SNAPSHOT.insufficientEvidence).toContainEqual(
      expect.objectContaining({ domain: 'ai.fengl.cc', reportCount: 1 }),
    )
  })

  it('keeps complete HTTPS attribution and valid public metrics', () => {
    expect(VERIDROP_RELAY_SNAPSHOT.sourceUrl).toBe('https://veridrop.org/leaderboard')
    expect(VERIDROP_RELAY_SNAPSHOT.sourceTemplateVersion).toBe(
      '20260713-leaderboard-top40-green-protocols-v1',
    )

    for (const site of listedSites) {
      expect(site.sourceUrl).toBe(`https://veridrop.org/leaderboard/${site.domain}`)
      expect(site.sourceScore).toBeGreaterThanOrEqual(0)
      expect(site.sourceScore).toBeLessThanOrEqual(100)
      expect(site.reportCount).toBeGreaterThan(0)
      expect(site.protocols.length).toBeGreaterThan(0)
    }
  })

  it('never displays a date after capture without retaining and flagging the source value', () => {
    const capturedAt = VERIDROP_RELAY_SNAPSHOT.capturedAt

    for (const site of listedSites) {
      expect(site.lastCheckedAt <= capturedAt).toBe(true)
      if (site.sourceReportedLastCheckedAt && site.sourceReportedLastCheckedAt > capturedAt) {
        expect(site.dateAdjusted).toBe(true)
        expect(site.dataQualityNote).toBeTruthy()
      }
    }

    expect(VERIDROP_RELAY_SNAPSHOT.referenceSites).toContainEqual(
      expect.objectContaining({
        domain: 'dragtokens.com',
        lastCheckedAt: '2026-07-18',
        sourceReportedLastCheckedAt: '2026-07-19',
        dateAdjusted: true,
      }),
    )
  })

  it('discloses the first-party relationship and never stores an API key', () => {
    expect(FIRST_PARTY_RELAY_SNAPSHOT.disclosure).toBe('格物自营推广')
    expect(FIRST_PARTY_RELAY_SNAPSHOT.tests).toHaveLength(3)
    expect(FIRST_PARTY_RELAY_SNAPSHOT.tests.map((test) => test.score)).toEqual([90.6, 98.3, 98.3])
    expect(JSON.stringify(FIRST_PARTY_RELAY_SNAPSHOT)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
    expect(JSON.stringify(FIRST_PARTY_RELAY_SNAPSHOT)).not.toContain('apiKey')
  })
})