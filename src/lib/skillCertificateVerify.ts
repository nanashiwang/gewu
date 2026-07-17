import { createHash, createPublicKey, verify as edVerify } from 'crypto'
import { canonicalString } from './canonical'
import { evidenceVerifyPageUrl } from './evidenceLinks'

export type SkillCertificatePublicKeyInfo = { keyId: string; algorithm: string; publicKey: string } | null | undefined

export type SkillCertificateSignature = {
  algorithm?: string | null
  keyId?: string | null
  signature?: string | null
}

export type SkillCertificateVerifyStatus =
  | 'valid'
  | 'unsigned'
  | 'hash_mismatch'
  | 'key_unavailable'
  | 'signature_invalid'
  | 'invalid'

export type SkillCertificateVerifyResult = {
  status: SkillCertificateVerifyStatus
  valid: boolean
  computedHash: string | null
  hashValid: boolean
  signatureValid: boolean
  keyMatch: boolean
  reason: string
  auditPlaybook?: SkillCertificateAuditPlaybook
  certificateSummary?: SkillCertificateVerifySummary | null
}

export type SkillCertificateAuditPlaybook = {
  customerValue: string
  decision: 'accept' | 'review' | 'reject'
  nextActions: Array<{ label: string; description: string; href?: string | null }>
}

export type SkillCertificateVerifySummary = {
  subject?: { id?: string; slug?: string; title?: string }
  status?: string
  statusReasons?: string[]
  issuedAt?: string
  passport?: {
    id?: string
    status?: string
    skillClass?: string
    trustScore?: number
    evidenceHash?: string
    evidenceVerifyPageUrl?: string | null
    trustedCompatibleRunCount?: number
    compatibility?: { modelCount?: number; bestModel?: unknown; models?: unknown[] }
  }
  contract?: { version?: string | null; contractHash?: string | null; contractStatus?: string | null; permissions?: unknown; minRunnerVersion?: string | null } | null
  benchmark?: {
    total?: number
    passed?: number
    averageScore?: number
    evidenceHash?: string
    cases?: Array<{ caseId?: string; title?: string; total?: number; passed?: number; averageScore?: number; status?: string; models?: string[]; lastRunAt?: string }>
  }
}


export type SkillCertificateVerifyRequest = {
  certificate: any | null
  certificateSignature?: SkillCertificateSignature | null
  publicKeyInfo?: SkillCertificatePublicKeyInfo
  error?: 'payload_too_large' | 'invalid_structure'
  reason?: string
}

export const MAX_CERTIFICATE_VERIFY_BYTES = 500_000
const MAX_SIGNATURE_BYTES = 4096
const MAX_PUBLIC_KEY_BYTES = 8192

function usablePublicKey(value: any): SkillCertificatePublicKeyInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.publicKey) return null
  if (Buffer.byteLength(String(value.publicKey), 'utf8') > MAX_PUBLIC_KEY_BYTES) return null
  return value
}

function requestTooLarge(value: any): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CERTIFICATE_VERIFY_BYTES
  } catch {
    return true
  }
}

function usableSignature(value: any): SkillCertificateSignature | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const signature = value.signature == null ? null : String(value.signature)
  if (signature && Buffer.byteLength(signature, 'utf8') > MAX_SIGNATURE_BYTES) return null
  return value
}

export function normalizeSkillCertificateVerifyRequest(body: any): SkillCertificateVerifyRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { certificate: null, certificateSignature: null, publicKeyInfo: null, error: 'invalid_structure', reason: '请求体必须是 JSON 对象' }
  }
  if (requestTooLarge(body)) {
    return { certificate: null, certificateSignature: null, publicKeyInfo: null, error: 'payload_too_large', reason: '证书验签请求体过大' }
  }
  if (body?.certificate && typeof body.certificate === 'object') {
    if (Array.isArray(body.certificate)) {
      return { certificate: null, certificateSignature: null, publicKeyInfo: null, error: 'invalid_structure', reason: 'certificate 必须是对象' }
    }
    return {
      certificate: body.certificate,
      certificateSignature: usableSignature(body.certificateSignature),
      publicKeyInfo: usablePublicKey(body.publicKeyInfo) ?? usablePublicKey(body.publicKey) ?? null,
    }
  }
  if (body?.schemaVersion === 'gewu.skill.certificate/v1') {
    return {
      certificate: body,
      certificateSignature: null,
      publicKeyInfo: null,
    }
  }
  return { certificate: null, certificateSignature: null, publicKeyInfo: null }
}


function certificateSummary(certificate: any): SkillCertificateVerifySummary | null {
  if (!certificate || typeof certificate !== 'object' || Array.isArray(certificate)) return null
  return {
    subject: certificate.subject
      ? {
          id: certificate.subject.id ? String(certificate.subject.id) : undefined,
          slug: certificate.subject.slug ? String(certificate.subject.slug) : undefined,
          title: certificate.subject.title ? String(certificate.subject.title) : undefined,
        }
      : undefined,
    status: certificate.status ? String(certificate.status) : undefined,
    statusReasons: Array.isArray(certificate.statusReasons)
      ? certificate.statusReasons.map((r: unknown) => String(r))
      : undefined,
    issuedAt: certificate.issuedAt ? String(certificate.issuedAt) : undefined,
    passport: certificate.passport
      ? {
          id: certificate.passport.id ? String(certificate.passport.id) : undefined,
          status: certificate.passport.status,
          skillClass: certificate.passport.skillClass,
          trustScore: certificate.passport.trustScore,
          evidenceHash: certificate.passport.evidenceHash,
          evidenceVerifyPageUrl: certificate.passport.id
            ? evidenceVerifyPageUrl('skill_passport', certificate.passport.id)
            : null,
          trustedCompatibleRunCount: certificate.passport.trustedCompatibleRunCount,
          compatibility: certificate.passport.compatibility
            ? {
                modelCount: certificate.passport.compatibility.modelCount,
                bestModel: certificate.passport.compatibility.bestModel,
                models: Array.isArray(certificate.passport.compatibility.models)
                  ? certificate.passport.compatibility.models.map((m: any) => ({
                      modelName: m?.modelName || null,
                      modelVersion: m?.modelVersion || null,
                      reports: m?.reports ?? null,
                      verified: m?.verified ?? null,
                      effectiveSamples: m?.effectiveSamples ?? null,
                    }))
                  : [],
              }
            : undefined,
        }
      : undefined,
    contract: certificate.contract
      ? {
          version: certificate.contract.version || null,
          contractHash: certificate.contract.contractHash || null,
          contractStatus: certificate.contract.contractStatus || null,
          permissions: certificate.contract.permissions || null,
          minRunnerVersion: certificate.contract.minRunnerVersion || null,
        }
      : null,
    benchmark: certificate.benchmark
      ? {
          total: certificate.benchmark.total,
          passed: certificate.benchmark.passed,
          averageScore: certificate.benchmark.averageScore,
          evidenceHash: certificate.benchmark.evidenceHash,
          cases: Array.isArray(certificate.benchmark.cases)
            ? certificate.benchmark.cases.slice(0, 50).map((item: any) => ({
                caseId: item?.caseId ? String(item.caseId) : undefined,
                title: item?.title ? String(item.title) : undefined,
                total: item?.total,
                passed: item?.passed,
                averageScore: item?.averageScore,
                status: item?.status ? String(item.status) : undefined,
                models: Array.isArray(item?.models) ? item.models.map((model: unknown) => String(model)).slice(0, 20) : [],
                lastRunAt: item?.lastRunAt ? String(item.lastRunAt) : undefined,
              }))
            : [],
        }
      : undefined,
  }
}

function certificateSigningCore(certificate: any): any | null {
  if (!certificate || typeof certificate !== 'object' || Array.isArray(certificate)) return null
  return { ...certificate }
}

function certificateAuditPlaybook(
  status: SkillCertificateVerifyStatus,
  summary: SkillCertificateVerifySummary | null,
): SkillCertificateAuditPlaybook {
  const certificateStatus = summary?.status
  const decision =
    status === 'valid' && certificateStatus === 'passed'
      ? 'accept'
      : status === 'hash_mismatch' || status === 'signature_invalid' || status === 'invalid'
        ? 'reject'
        : 'review'
  const reasons = summary?.statusReasons?.length
    ? `未达标原因：${summary.statusReasons.join(' / ')}。`
    : ''
  return {
    customerValue:
      '把证书验签结果翻译成采购/企业准入动作：先确认签名与哈希，再核对 Contract、Passport、黄金样例和证据快照。',
    decision,
    nextActions: [
      {
        label: '核对签名与哈希',
        description:
          status === 'valid'
            ? 'certificateHash 与 ed25519 签名均有效，证书载荷未被篡改。'
            : '证书未通过完整验签，不应作为正式采购或企业准入依据。',
      },
      {
        label: '核对 Contract',
        description: summary?.contract?.contractHash
          ? `已绑定 Contract ${summary.contract.version || ''}，确认权限、输入输出契约和 Runner 版本是否符合内部要求。`
          : '证书未绑定可复核 Contract，需转人工复核。',
      },
      {
        label: '核对 Passport 与样例',
        description: `Passport 可信分 ${summary?.passport?.trustScore ?? '—'}，黄金样例 ${summary?.benchmark?.passed ?? 0}/${summary?.benchmark?.total ?? 0}。${reasons}`,
        href: summary?.passport?.evidenceVerifyPageUrl || null,
      },
      {
        label: '形成准入结论',
        description:
          decision === 'accept'
            ? '可进入企业 Registry 或采购复核的通过候选。'
            : decision === 'reject'
              ? '证据链异常，建议拒绝或要求重新签发。'
              : '签名或业务状态仍需人工复核，不要直接当作正式达标。',
      },
    ],
  }
}

export function skillCertificateHash(certificate: any): string | null {
  const core = certificateSigningCore(certificate)
  if (!core) return null
  delete core.certificateHash
  return createHash('sha256').update(canonicalString(core)).digest('hex')
}

export function verifySkillCertificate(args: {
  certificate: any
  certificateSignature?: SkillCertificateSignature | null
  publicKeyInfo?: SkillCertificatePublicKeyInfo
}): SkillCertificateVerifyResult {
  const certificate = args.certificate
  if (!certificate || typeof certificate !== 'object' || Array.isArray(certificate)) {
    return {
      status: 'invalid',
      valid: false,
      computedHash: null,
      hashValid: false,
      signatureValid: false,
      keyMatch: false,
      reason: '证书载荷无效',
    }
  }

  const summary = certificateSummary(certificate)
  const computedHash = skillCertificateHash(certificate)
  const hashValid = Boolean(computedHash && computedHash === String(certificate.certificateHash || ''))
  if (!hashValid) {
    return {
      status: 'hash_mismatch',
      valid: false,
      computedHash,
      hashValid: false,
      signatureValid: false,
      keyMatch: false,
      reason: 'certificateHash 与规范化证书载荷不一致',
      auditPlaybook: certificateAuditPlaybook('hash_mismatch', summary),
      certificateSummary: summary,
    }
  }

  const sig = args.certificateSignature
  if (!sig?.signature || !sig?.keyId) {
    return {
      status: 'unsigned',
      valid: false,
      computedHash,
      hashValid: true,
      signatureValid: false,
      keyMatch: false,
      reason: '证书未签名，仅可验证哈希',
      auditPlaybook: certificateAuditPlaybook('unsigned', summary),
      certificateSummary: summary,
    }
  }
  if (sig.algorithm !== 'ed25519') {
    return {
      status: 'signature_invalid',
      valid: false,
      computedHash,
      hashValid: true,
      signatureValid: false,
      keyMatch: false,
      reason: '证书签名算法不支持',
      auditPlaybook: certificateAuditPlaybook('signature_invalid', summary),
      certificateSummary: summary,
    }
  }

  const publicKeyInfo = args.publicKeyInfo
  if (!publicKeyInfo || publicKeyInfo.algorithm !== 'ed25519' || !publicKeyInfo.publicKey) {
    return {
      status: 'key_unavailable',
      valid: false,
      computedHash,
      hashValid: true,
      signatureValid: false,
      keyMatch: false,
      reason: '当前站点未公开可用 ed25519 公钥',
      auditPlaybook: certificateAuditPlaybook('key_unavailable', summary),
      certificateSummary: summary,
    }
  }

  const keyMatch = sig.keyId === publicKeyInfo.keyId
  if (!keyMatch) {
    return {
      status: 'key_unavailable',
      valid: false,
      computedHash,
      hashValid: true,
      signatureValid: false,
      keyMatch: false,
      reason: '证书 keyId 与当前公钥不一致',
      auditPlaybook: certificateAuditPlaybook('key_unavailable', summary),
      certificateSummary: summary,
    }
  }

  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyInfo.publicKey, 'base64'), format: 'der', type: 'spki' })
    const signatureValid = edVerify(
      null,
      Buffer.from(canonicalString(certificate), 'utf8'),
      publicKey,
      Buffer.from(sig.signature, 'base64'),
    )
    return {
      status: signatureValid ? 'valid' : 'signature_invalid',
      valid: signatureValid,
      computedHash,
      hashValid: true,
      signatureValid,
      keyMatch: true,
      reason: signatureValid ? '证书哈希与 ed25519 签名均有效' : '证书签名校验失败',
      auditPlaybook: certificateAuditPlaybook(
        signatureValid ? 'valid' : 'signature_invalid',
        summary,
      ),
      certificateSummary: summary,
    }
  } catch {
    return {
      status: 'signature_invalid',
      valid: false,
      computedHash,
      hashValid: true,
      signatureValid: false,
      keyMatch: true,
      reason: '公钥或签名格式无效',
      auditPlaybook: certificateAuditPlaybook('signature_invalid', summary),
      certificateSummary: summary,
    }
  }
}
