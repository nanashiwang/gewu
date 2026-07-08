import { describe, expect, it } from 'vitest'
import { getEnterpriseGovernanceOverview } from '@/lib/enterpriseOverview'

function payloadMock() {
  const org = {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    owner: 'owner-1',
    status: 'active',
    identityPolicy: {
      requireSso: true,
      domainAllowlist: ['example.com'],
      sso: { enabled: true, provider: 'oidc', issuer: 'https://idp.example.com', clientId: 'client-1' },
      scim: { enabled: true, baseUrl: 'https://api.example.com/scim', tokenDigest: 'sha256:'.padEnd(71, 'a') },
    },
  }
  const registries = [
    { id: 'reg-1', organization: 'org-1', name: 'Writer', approvalStatus: 'approved', skill: { id: 'skill-1', title: 'Writer', slug: 'writer' }, updatedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'reg-2', organization: 'org-1', name: 'Coder', approvalStatus: 'pending', skill: { id: 'skill-2', title: 'Coder', slug: 'coder' }, updatedAt: '2026-07-02T00:00:00.000Z' },
    { id: 'reg-3', organization: 'org-1', name: 'Brief', approvalStatus: 'restricted', adoptionBaseline: { capturedAt: '2026-07-01T00:00:00.000Z' }, skill: { id: 'skill-3', title: 'Brief', slug: 'brief' }, updatedAt: '2026-07-03T00:00:00.000Z' },
  ]
  const members = [
    { id: 'm-1', organization: 'org-1', user: 'u-1', role: 'admin', status: 'active' },
    { id: 'm-2', organization: 'org-1', user: 'u-2', role: 'approver', status: 'active' },
    { id: 'm-3', organization: 'org-1', user: 'u-3', role: 'member', status: 'suspended' },
  ]
  const audits = [
    { id: 'a-1', organization: 'org-1', outcome: 'success', modelName: 'gpt', modelVersion: '1', skill: { id: 'skill-1', title: 'Writer' }, estimatedCost: 0.01, chargedCredits: 1, createdAt: '2026-07-04T00:00:00.000Z' },
    { id: 'a-2', organization: 'org-1', outcome: 'failed', errorCode: 'timeout', modelName: 'gpt', modelVersion: '1', skill: { id: 'skill-1', title: 'Writer' }, inputSizeBucket: '500-2k', createdAt: '2026-07-03T00:00:00.000Z' },
    { id: 'a-3', organization: 'org-1', outcome: 'denied', policyReason: 'secret policy', modelName: 'qwen', skill: { id: 'skill-2', title: 'Coder' }, inputSizeBucket: '0-100', createdAt: '2026-07-02T00:00:00.000Z' },
  ]

  return {
    findByID: async ({ collection }: any) => (collection === 'organizations' ? org : null),
    find: async ({ collection }: any) => {
      if (collection === 'enterprise-registries') return { docs: registries, totalDocs: registries.length }
      if (collection === 'organization-members') return { docs: members, totalDocs: members.length }
      if (collection === 'enterprise-audit-logs') return { docs: audits, totalDocs: audits.length }
      return { docs: [], totalDocs: 0 }
    },
  }
}

describe('enterpriseOverview — 企业治理总览', () => {
  it('聚合准入、身份、审计和失败库摘要且不泄露敏感值', async () => {
    const result = await getEnterpriseGovernanceOverview(payloadMock() as any, {
      actorId: 'owner-1',
      actorRole: 'enterprise_admin',
      organizationId: 'org-1',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.overview).toMatchObject({
      organization: { id: 'org-1', name: 'Acme' },
      registry: {
        total: 3,
        byStatus: { approved: 1, pending: 1, restricted: 1, disabled: 0 },
      },
      members: { byStatus: { active: 2, suspended: 1 } },
      audit: { byOutcome: { success: 1, failed: 1, denied: 1 } },
      identity: { readiness: { ssoEnabled: true, scimEnabled: true, blockers: 0 } },
    })
    expect(result.overview.reapproval.actionable).toBeGreaterThan(0)
    expect(result.overview.failures.topGroups[0]).toMatchObject({ errorType: 'policy_denied' })
    expect(JSON.stringify(result.overview)).not.toContain('secret policy')
    expect(JSON.stringify(result.overview)).not.toContain('sha256:aaaa')
  })
})
