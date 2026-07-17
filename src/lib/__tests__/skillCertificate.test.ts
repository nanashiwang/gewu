import { createPublicKey, generateKeyPairSync, verify as edVerify } from 'crypto'
import { describe, expect, it } from 'vitest'
import { canonicalString } from '@/lib/canonical'
import { buildSkillCertificate, buildSkillCertificateCore } from '@/lib/skillCertificate'
import { getPublicKeyInfo } from '@/lib/signing'

function envWithKey() {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { GEWU_SIGNING_KEY: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64') }
}

const baseInput = {
  skill: { id: 'skill-1', slug: 'writer', title: 'Writer' },
  passport: {
    id: 'passport-1',
    status: 'current',
    skillClass: 'verified',
    trustScore: 82,
    signatureStatus: 'signed',
    manifestChecksum: 'sha256:abc',
    evidenceHash: 'p'.repeat(64),
    reliabilitySummary: { trustedCompatibleRunCount: 4 },
    compatibilitySummary: {
      bestModel: { modelName: 'qwen-plus', modelVersion: '2026-07-01' },
      models: [
        {
          modelName: 'qwen-plus',
          modelVersion: '2026-07-01',
          modelProfile: 'profile-1',
          reports: 5,
          verified: 2,
          effectiveSamples: 3.5,
          successRate: 0.9,
          formatRate: 0.8,
          lowSample: false,
        },
      ],
    },
    lastVerifiedAt: '2026-01-01T00:00:00.000Z',
  },
  contractSummary: {
    version: '1.0.0',
    contractHash: 'c'.repeat(64),
    contractStatus: 'initial',
    systemPromptHash: 's'.repeat(64),
    promptTemplateHash: 't'.repeat(64),
    inputSchema: { type: 'object', required: ['topic'] },
    outputSchema: { type: 'object', required: ['text'] },
    recommendedModels: { cloud: ['gpt-4.1-mini'] },
    routePolicy: { mode: 'balanced' },
    permissions: { network: false },
    minRunnerVersion: '0.1.0',
    examplesCount: 2,
  },
  benchmarkSummary: {
    total: 2,
    passed: 2,
    averageScore: 1,
    evidenceHash: 'b'.repeat(64),
    cases: [
      {
        caseId: 'case-1',
        title: 'JSON 标题',
        total: 2,
        passed: 2,
        averageScore: 1,
        models: ['qwen-plus'],
        lastRunAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
  evidenceSnapshotVerify: { status: 'valid', hashValid: true, signatureValid: true },
  issuedAt: '2026-01-02T00:00:00.000Z',
}

describe('skillCertificate — 第三方可复核证书', () => {
  it('达标 Skill 生成 passed 证书和稳定 hash', () => {
    const core = buildSkillCertificateCore(baseInput)
    expect(core.status).toBe('passed')
    expect(core.statusReasons).toEqual([])
    expect(core.certificateHash).toHaveLength(64)
    expect(core.passport.trustedCompatibleRunCount).toBe(4)
    expect(core.passport.compatibility).toMatchObject({
      modelCount: 1,
      bestModel: { modelName: 'qwen-plus', modelVersion: '2026-07-01' },
      models: [{ modelName: 'qwen-plus', modelVersion: '2026-07-01', modelProfile: 'profile-1' }],
    })
    expect(core.contract).toMatchObject({
      version: '1.0.0',
      contractHash: 'c'.repeat(64),
      inputSchemaHash: expect.any(String),
      outputSchemaHash: expect.any(String),
      permissions: { network: false },
    })
    expect(core.benchmark.cases).toEqual([
      expect.objectContaining({
        caseId: 'case-1',
        title: 'JSON 标题',
        total: 2,
        passed: 2,
        averageScore: 1,
        status: 'passed',
        models: ['qwen-plus'],
      }),
    ])
    expect((core.contract as any).inputSchema).toBeUndefined()
    expect(buildSkillCertificateCore({ ...baseInput }).certificateHash).toBe(core.certificateHash)
  })

  it('Contract 摘要变化会改变证书 hash', () => {
    const a = buildSkillCertificateCore(baseInput)
    const b = buildSkillCertificateCore({
      ...baseInput,
      contractSummary: { ...baseInput.contractSummary, contractHash: 'd'.repeat(64) },
    })
    expect(b.contract?.contractHash).toBe('d'.repeat(64))
    expect(b.certificateHash).not.toBe(a.certificateHash)
  })

  it('缺少有效 Contract 时不能生成达标证书', () => {
    const core = buildSkillCertificateCore({ ...baseInput, contractSummary: null })
    expect(core.status).toBe('failed')
    expect(core.statusReasons).toContain('contract_missing')
    expect(core.contract).toBeNull()
  })

  it('黄金样例未全通过时证书为 failed', () => {
    const core = buildSkillCertificateCore({ ...baseInput, benchmarkSummary: { total: 2, passed: 1, averageScore: 0.7, evidenceHash: 'b'.repeat(64) } })
    expect(core.status).toBe('failed')
    expect(core.statusReasons).toContain('benchmark_failed')
  })

  it('缺少有效证据快照时只能生成预备证书', () => {
    const missing = buildSkillCertificateCore({ ...baseInput, evidenceSnapshotVerify: null })
    expect(missing.status).toBe('provisional')
    expect(missing.statusReasons).toContain('evidence_snapshot_missing')
    const invalid = buildSkillCertificateCore({
      ...baseInput,
      evidenceSnapshotVerify: { status: 'hash_mismatch', hashValid: false, signatureValid: false },
    })
    expect(invalid.status).toBe('provisional')
    expect(invalid.statusReasons).toContain('evidence_snapshot_invalid')
  })

  it('预备证书给出未达正式达标的原因', () => {
    const core = buildSkillCertificateCore({
      ...baseInput,
      passport: { ...baseInput.passport, status: 'draft', skillClass: 'imported', signatureStatus: 'checksum_only', trustScore: 30 },
      benchmarkSummary: { total: 0, passed: 0, averageScore: 0, evidenceHash: 'b'.repeat(64) },
    })
    expect(core.status).toBe('provisional')
    expect(core.statusReasons).toEqual(
      expect.arrayContaining([
        'passport_not_current',
        'skill_not_verified',
        'manifest_not_signed',
        'trust_score_low',
        'benchmark_missing',
      ]),
    )
  })

  it('证书签名可被公开公钥验签', () => {
    const env = envWithKey()
    const built = buildSkillCertificate(baseInput, env)
    expect(built.certificateSignature).toMatchObject({ algorithm: 'ed25519', keyId: expect.any(String) })
    expect(built.publicKey).toMatchObject({ keyId: expect.any(String), algorithm: 'ed25519', publicKey: expect.any(String) })
    expect(built.evidenceVerifyUrl).toBe('/v1/evidence/verify?targetType=skill_passport&targetId=passport-1')
    expect(built.evidenceVerifyPageUrl).toBe('/verify?targetType=skill_passport&targetId=passport-1')
    const info = getPublicKeyInfo(env)!
    const publicKey = createPublicKey({ key: Buffer.from(info.publicKey, 'base64'), format: 'der', type: 'spki' })
    expect(edVerify(null, Buffer.from(canonicalString(built.certificate), 'utf8'), publicKey, Buffer.from(built.certificateSignature!.signature, 'base64'))).toBe(true)
  })
})
