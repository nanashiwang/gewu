import { evidenceHash } from './evidenceHash'
import { evidenceVerifyApiUrl, evidenceVerifyPageUrl } from './evidenceLinks'
import { getPublicKeyInfo, signCanonical } from './signing'

export type CertificateStatus = 'passed' | 'provisional' | 'failed'
export type CertificateStatusReason =
  | 'passport_revoked'
  | 'skill_rejected'
  | 'passport_not_current'
  | 'contract_missing'
  | 'skill_not_verified'
  | 'manifest_not_signed'
  | 'trust_score_low'
  | 'benchmark_missing'
  | 'benchmark_failed'
  | 'evidence_snapshot_missing'
  | 'evidence_snapshot_invalid'

export type SkillCertificateInput = {
  skill: { id: string; slug: string; title: string }
  passport: any
  contractSummary?: any
  benchmarkSummary?: any
  evidenceSnapshotVerify?: { status?: string; hashValid?: boolean; signatureValid?: boolean } | null
  issuedAt?: string
}

function certificateContractSummary(contract: any) {
  if (!contract) return null
  return {
    version: contract.version || null,
    contractHash: contract.contractHash || null,
    contractStatus: contract.contractStatus || null,
    systemPromptHash: contract.systemPromptHash || null,
    promptTemplateHash: contract.promptTemplateHash || null,
    inputSchemaHash: evidenceHash(contract.inputSchema || null),
    outputSchemaHash: evidenceHash(contract.outputSchema || null),
    recommendedModelsHash: evidenceHash(contract.recommendedModels || null),
    routePolicyHash: evidenceHash(contract.routePolicy || null),
    permissions: contract.permissions || null,
    minRunnerVersion: contract.minRunnerVersion || null,
    examplesCount: Number(contract.examplesCount || 0),
  }
}

function certificateStatusReasons(input: SkillCertificateInput): CertificateStatusReason[] {
  const passport = input.passport || {}
  const benchmark = input.benchmarkSummary || {}
  const reasons: CertificateStatusReason[] = []
  if (passport.status === 'revoked') reasons.push('passport_revoked')
  if (passport.skillClass === 'rejected') reasons.push('skill_rejected')
  if (passport.status !== 'current') reasons.push('passport_not_current')
  if (!input.contractSummary) reasons.push('contract_missing')
  if (passport.skillClass !== 'verified') reasons.push('skill_not_verified')
  if (passport.signatureStatus !== 'signed') reasons.push('manifest_not_signed')
  if (Number(passport.trustScore || 0) < 60) reasons.push('trust_score_low')
  if (!benchmark.total) reasons.push('benchmark_missing')
  if (benchmark.total > 0 && benchmark.passed < benchmark.total) reasons.push('benchmark_failed')
  if (!input.evidenceSnapshotVerify) reasons.push('evidence_snapshot_missing')
  if (input.evidenceSnapshotVerify && input.evidenceSnapshotVerify.status !== 'valid') {
    reasons.push('evidence_snapshot_invalid')
  }
  return reasons
}

function certificateStatus(input: SkillCertificateInput, reasons: CertificateStatusReason[]): CertificateStatus {
  if (reasons.includes('passport_revoked') || reasons.includes('skill_rejected')) return 'failed'
  if (reasons.includes('contract_missing')) return 'failed'
  if (reasons.includes('benchmark_failed')) return 'failed'
  if (
    reasons.length === 0
  ) return 'passed'
  return 'provisional'
}

function trustedCompatibleRunCount(passport: any): number {
  const reliability = passport?.reliabilitySummary || {}
  const evidence = passport?.evidenceSummary || {}
  const value = reliability.trustedCompatibleRunCount ?? evidence.trustedCompatibleRunCount ?? 0
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function certificateCompatibilitySummary(passport: any) {
  const summary = passport?.compatibilitySummary || {}
  const models = Array.isArray(summary.models) ? summary.models : []
  return {
    modelCount: models.length,
    bestModel: summary.bestModel || null,
    models: models.map((m: any) => ({
      modelName: m?.modelName || null,
      modelVersion: m?.modelVersion || null,
      modelProfile: m?.modelProfile || null,
      reports: Number(m?.reports || 0),
      verified: Number(m?.verified || 0),
      effectiveSamples: m?.effectiveSamples ?? null,
      successRate: m?.successRate ?? null,
      formatRate: m?.formatRate ?? null,
      lowSample: Boolean(m?.lowSample),
    })),
  }
}

function certificateBenchmarkSummary(benchmark: any) {
  const cases = Array.isArray(benchmark?.cases) ? benchmark.cases : []
  return {
    total: benchmark?.total || 0,
    passed: benchmark?.passed || 0,
    averageScore: benchmark?.averageScore || 0,
    evidenceHash: benchmark?.evidenceHash || evidenceHash(benchmark),
    cases: cases.slice(0, 50).map((item: any) => ({
      caseId: item?.caseId ? String(item.caseId) : 'unknown',
      title: item?.title ? String(item.title) : '未命名样例',
      total: Number(item?.total || 0),
      passed: Number(item?.passed || 0),
      averageScore: item?.averageScore ?? 0,
      status: Number(item?.total || 0) <= 0
        ? 'no_runs'
        : Number(item?.passed || 0) >= Number(item?.total || 0)
          ? 'passed'
          : Number(item?.passed || 0) > 0
            ? 'partial'
            : 'failed',
      models: Array.isArray(item?.models) ? item.models.map((model: unknown) => String(model)).slice(0, 20) : [],
      lastRunAt: item?.lastRunAt || undefined,
    })),
  }
}

export function buildSkillCertificateCore(input: SkillCertificateInput) {
  const benchmark = input.benchmarkSummary || { total: 0, passed: 0, averageScore: 0, cases: [], evidenceHash: evidenceHash({ total: 0, passed: 0, averageScore: 0, cases: [] }) }
  const passport = input.passport || {}
  const statusReasons = certificateStatusReasons(input)
  const core = {
    schemaVersion: 'gewu.skill.certificate/v1',
    issuedAt: input.issuedAt || new Date().toISOString(),
    subject: input.skill,
    status: certificateStatus(input, statusReasons),
    statusReasons,
    passport: {
      id: passport.id,
      status: passport.status,
      skillClass: passport.skillClass,
      trustScore: passport.trustScore,
      signatureStatus: passport.signatureStatus,
      manifestChecksum: passport.manifestChecksum,
      evidenceHash: passport.evidenceHash,
      trustedCompatibleRunCount: trustedCompatibleRunCount(passport),
      compatibility: certificateCompatibilitySummary(passport),
      lastVerifiedAt: passport.lastVerifiedAt,
    },
    contract: certificateContractSummary(input.contractSummary),
    benchmark: certificateBenchmarkSummary(benchmark),
    evidenceSnapshot: input.evidenceSnapshotVerify
      ? {
          status: input.evidenceSnapshotVerify.status,
          hashValid: input.evidenceSnapshotVerify.hashValid,
          signatureValid: input.evidenceSnapshotVerify.signatureValid,
        }
      : null,
  }
  return { ...core, certificateHash: evidenceHash(core) }
}

export function signSkillCertificate(core: ReturnType<typeof buildSkillCertificateCore>, env: Record<string, string | undefined> = process.env) {
  const signature = signCanonical(core, env)
  const publicKey = getPublicKeyInfo(env)
  return signature && publicKey
    ? { algorithm: 'ed25519', keyId: publicKey.keyId, signature }
    : null
}

export function buildSkillCertificate(input: SkillCertificateInput, env: Record<string, string | undefined> = process.env) {
  const core = buildSkillCertificateCore(input)
  const passportId = input.passport?.id
  return {
    certificate: core,
    certificateSignature: signSkillCertificate(core, env),
    publicKey: getPublicKeyInfo(env),
    evidenceVerifyUrl: evidenceVerifyApiUrl('skill_passport', passportId),
    evidenceVerifyPageUrl: evidenceVerifyPageUrl('skill_passport', passportId),
  }
}
