import { describe, expect, it } from 'vitest'
import {
  buildEnterpriseRegistryEvidencePackage,
  buildPublicSkillEvidencePackage,
} from '@/lib/evidencePackage'

function payloadMock() {
  const version = {
    id: 'ver-1',
    skill: 'skill-1',
    version: '1.0.0',
    status: 'active',
    contractStatus: 'initial',
    systemPrompt: 'prompt-secret',
    promptTemplate: 'template-secret',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    examples: [{ input: 'example-secret', output: 'example-output-secret' }],
    permissions: { network: false },
  }
  const skill = {
    id: 'skill-1',
    slug: 'writer',
    title: 'Writer',
    status: 'published',
    visibility: 'public',
    currentVersion: version,
  }
  const passport = {
    id: 'passport-1',
    status: 'current',
    skillClass: 'verified',
    trustScore: 88,
    signatureStatus: 'signed',
    manifestChecksum: 'sha256:manifest',
    evidenceHash: 'hash-1',
    reliabilitySummary: { trustedCompatibleRunCount: 8 },
    lastVerifiedAt: '2026-07-08T00:00:00.000Z',
  }
  return {
    logger: { warn: () => {} },
    findGlobal: async () => { throw new Error('no settings') },
    find: async ({ collection }: any) => {
      if (collection === 'skills') return { docs: [skill], totalDocs: 1 }
      if (collection === 'skill-passports') return { docs: [passport], totalDocs: 1 }
      if (collection === 'evidence-snapshots') return { docs: [], totalDocs: 0 }
      if (collection === 'compat-reports') return { docs: [], totalDocs: 0 }
      return { docs: [], totalDocs: 0 }
    },
  }
}

function enterprisePayloadMock() {
  const base = payloadMock() as any
  const version = {
    id: 'ver-1',
    skill: 'skill-1',
    version: '1.0.0',
    status: 'active',
    systemPrompt: 'enterprise-prompt-secret',
    promptTemplate: 'enterprise-template-secret',
  }
  const skill = { id: 'skill-1', slug: 'writer', title: 'Writer', currentVersion: version }
  const passport = {
    id: 'passport-1',
    skill: 'skill-1',
    status: 'current',
    skillClass: 'verified',
    trustScore: 90,
    signatureStatus: 'signed',
    manifestChecksum: 'sha256:manifest',
    evidenceHash: 'hash-1',
  }
  const registry = {
    id: 'reg-1',
    organization: 'org-1',
    skill,
    skillVersion: version,
    passport,
    approvalStatus: 'approved',
    auditPolicy: { requireByok: true },
    riskNotes: 'secret-risk-note',
  }
  const org = { id: 'org-1', owner: 'owner-1', status: 'active' }
  return {
    ...base,
    findByID: async ({ collection }: any) => {
      if (collection === 'enterprise-registries') return registry
      if (collection === 'organizations') return org
      if (collection === 'skill-passports') return passport
      if (collection === 'skills') return skill
      if (collection === 'skill-versions') return version
      return null
    },
  }
}

describe('evidencePackage — 证据包导出', () => {
  it('导出公开 Skill 证据包并排除 prompt/examples 原文', async () => {
    const result = await buildPublicSkillEvidencePackage(payloadMock() as any, { slug: 'writer' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.filename).toBe('gewu-evidence-writer.json')
    expect(result.package).toMatchObject({
      schemaVersion: 'gewu.evidence.package/v1',
      scope: 'public_skill',
      subject: { skill: { id: 'skill-1', slug: 'writer' } },
      manifest: { checksum: 'sha256:manifest', downloadUrl: '/v1/skills/writer/manifest' },
      contract: { version: '1.0.0', examplesCount: 1 },
      verification: { keysUrl: '/v1/keys' },
    })
    expect(result.package.packageHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.package.disclosure.excluded).toEqual(expect.arrayContaining(['prompt 正文', 'examples 原文', '用户输入输出']))
    const body = JSON.stringify(result.package)
    expect(body).not.toContain('prompt-secret')
    expect(body).not.toContain('template-secret')
    expect(body).not.toContain('example-secret')
    expect(body).not.toContain('example-output-secret')
  })

  it('导出企业 Registry 证据包时不带风险备注原文', async () => {
    const result = await buildEnterpriseRegistryEvidencePackage(enterprisePayloadMock() as any, {
      registryId: 'reg-1',
      userId: 'owner-1',
      userRole: 'enterprise_admin',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.package).toMatchObject({
      scope: 'enterprise_registry',
      subject: {
        registry: {
          id: 'reg-1',
          approvalStatus: 'approved',
          modelAllowlistCount: 0,
        },
        organizationId: 'org-1',
      },
    })
    const body = JSON.stringify(result.package)
    expect(body).not.toContain('secret-risk-note')
    expect(body).not.toContain('enterprise-prompt-secret')
    expect(body).not.toContain('enterprise-template-secret')
  })
})
