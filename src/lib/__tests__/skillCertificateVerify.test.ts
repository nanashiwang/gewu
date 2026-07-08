import { generateKeyPairSync } from 'crypto'
import { describe, expect, it } from 'vitest'
import { buildSkillCertificate } from '@/lib/skillCertificate'
import { getPublicKeyInfo } from '@/lib/signing'
import {
  MAX_CERTIFICATE_VERIFY_BYTES,
  normalizeSkillCertificateVerifyRequest,
  skillCertificateHash,
  verifySkillCertificate,
} from '@/lib/skillCertificateVerify'

function envWithKey() {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { HENGSHU_SIGNING_KEY: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64') }
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
      models: [{ modelName: 'qwen-plus', modelVersion: '2026-07-01', reports: 5, verified: 2, effectiveSamples: 3.5 }],
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
    permissions: { network: false },
    minRunnerVersion: '0.1.0',
    examplesCount: 2,
  },
  benchmarkSummary: {
    total: 2,
    passed: 2,
    averageScore: 1,
    evidenceHash: 'b'.repeat(64),
    cases: [{ caseId: 'case-1', title: 'JSON 标题', total: 2, passed: 2, averageScore: 1, status: 'passed', models: ['qwen-plus'] }],
  },
  evidenceSnapshotVerify: { status: 'valid', hashValid: true, signatureValid: true },
  issuedAt: '2026-01-02T00:00:00.000Z',
}

describe('skillCertificateVerify — 证书公开验签', () => {
  it('验证有效证书的 hash 与 ed25519 签名', () => {
    const env = envWithKey()
    const built = buildSkillCertificate(baseInput, env)
    const result = verifySkillCertificate({
      certificate: built.certificate,
      certificateSignature: built.certificateSignature,
      publicKeyInfo: getPublicKeyInfo(env),
    })
    expect(result).toMatchObject({
      status: 'valid',
      valid: true,
      hashValid: true,
      signatureValid: true,
      keyMatch: true,
      auditPlaybook: {
        customerValue: expect.stringContaining('采购/企业准入动作'),
        decision: 'accept',
        nextActions: expect.arrayContaining([
          expect.objectContaining({ label: '核对签名与哈希' }),
          expect.objectContaining({ label: '核对 Contract' }),
          expect.objectContaining({
            label: '核对 Passport 与样例',
            href: '/verify?targetType=skill_passport&targetId=passport-1',
          }),
          expect.objectContaining({ label: '形成准入结论' }),
        ]),
      },
      certificateSummary: {
        subject: { slug: 'writer', title: 'Writer' },
        passport: {
          id: 'passport-1',
          evidenceVerifyPageUrl: '/verify?targetType=skill_passport&targetId=passport-1',
          trustedCompatibleRunCount: 4,
          compatibility: {
            modelCount: 1,
            bestModel: { modelName: 'qwen-plus', modelVersion: '2026-07-01' },
            models: [{ modelName: 'qwen-plus', modelVersion: '2026-07-01', reports: 5, verified: 2, effectiveSamples: 3.5 }],
          },
        },
        contract: { contractHash: 'c'.repeat(64), contractStatus: 'initial', version: '1.0.0' },
        benchmark: {
          total: 2,
          passed: 2,
          cases: [{ caseId: 'case-1', title: 'JSON 标题', total: 2, passed: 2, averageScore: 1, status: 'passed', models: ['qwen-plus'] }],
        },
      },
    })
  })


  it('可直接使用证书 API 完整响应中的 publicKey 验签', () => {
    const env = envWithKey()
    const built = buildSkillCertificate(baseInput, env)
    const result = verifySkillCertificate({
      certificate: built.certificate,
      certificateSignature: built.certificateSignature,
      publicKeyInfo: built.publicKey,
    })
    expect(result).toMatchObject({ status: 'valid', valid: true, hashValid: true, signatureValid: true })
  })


  it('归一化完整响应、裸证书和不完整 publicKey', () => {
    const env = envWithKey()
    const built = buildSkillCertificate(baseInput, env)
    const wrapped = normalizeSkillCertificateVerifyRequest(built)
    expect(wrapped).toMatchObject({ certificate: built.certificate, certificateSignature: built.certificateSignature })
    expect(wrapped.publicKeyInfo).toMatchObject({ publicKey: expect.any(String) })

    const bare = normalizeSkillCertificateVerifyRequest(built.certificate)
    expect(bare).toMatchObject({ certificate: built.certificate, certificateSignature: null, publicKeyInfo: null })

    const incompleteKey = normalizeSkillCertificateVerifyRequest({
      certificate: built.certificate,
      certificateSignature: built.certificateSignature,
      publicKey: { keyId: 'kid', algorithm: 'ed25519' },
    })
    expect(incompleteKey.publicKeyInfo).toBeNull()
  })

  it('拒绝超大证书验签请求，避免公开接口被大 payload 压垮', () => {
    const oversized = normalizeSkillCertificateVerifyRequest({
      certificate: {
        schemaVersion: 'hengshu.skill.certificate/v1',
        subject: { title: 'x'.repeat(MAX_CERTIFICATE_VERIFY_BYTES) },
      },
    })
    expect(oversized).toMatchObject({
      certificate: null,
      error: 'payload_too_large',
    })
  })

  it('拒绝数组或数组 certificate 这类无效结构', () => {
    expect(normalizeSkillCertificateVerifyRequest([])).toMatchObject({
      certificate: null,
      error: 'invalid_structure',
    })
    expect(normalizeSkillCertificateVerifyRequest({ certificate: [] })).toMatchObject({
      certificate: null,
      error: 'invalid_structure',
    })
  })

  it('证书载荷被篡改时返回 hash_mismatch', () => {
    const env = envWithKey()
    const built = buildSkillCertificate(baseInput, env)
    const tampered = { ...built.certificate, status: 'failed' }
    const result = verifySkillCertificate({
      certificate: tampered,
      certificateSignature: built.certificateSignature,
      publicKeyInfo: getPublicKeyInfo(env),
    })
    expect(result).toMatchObject({
      status: 'hash_mismatch',
      valid: false,
      hashValid: false,
      signatureValid: false,
      auditPlaybook: { decision: 'reject' },
    })
  })

  it('篡改后重算 hash 但复用旧签名时返回 signature_invalid', () => {
    const env = envWithKey()
    const built = buildSkillCertificate(baseInput, env)
    const tampered = { ...built.certificate, status: 'provisional' }
    tampered.certificateHash = skillCertificateHash(tampered)!
    const result = verifySkillCertificate({
      certificate: tampered,
      certificateSignature: built.certificateSignature,
      publicKeyInfo: getPublicKeyInfo(env),
    })
    expect(result).toMatchObject({ status: 'signature_invalid', valid: false, hashValid: true, signatureValid: false })
  })

  it('无签名证书降级为 unsigned，但仍报告 hash 有效', () => {
    const built = buildSkillCertificate(baseInput, {})
    const result = verifySkillCertificate({ certificate: built.certificate, certificateSignature: null, publicKeyInfo: null })
    expect(result).toMatchObject({
      status: 'unsigned',
      valid: false,
      hashValid: true,
      signatureValid: false,
      auditPlaybook: { decision: 'review' },
    })
  })
})
