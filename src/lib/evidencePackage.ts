import type { Payload } from 'payload'
import { resolveRuntimeEnv } from './deploymentSettings'
import { evidenceHash } from './evidenceHash'
import { certificateVerifyPageUrl } from './evidenceLinks'
import { verifyEvidenceSnapshot } from './evidenceSnapshotVerify'
import {
  evaluateEnterpriseAdoptionBaselineDrift,
  getEnterpriseRegistryPassport,
} from './enterprise'
import { getSkillBenchmarkEvidence } from './benchmarkEvidence'
import { publicSkillPassport } from './passportPublic'
import { buildSkillCertificate } from './skillCertificate'
import { publicSkillContract } from './skillContractPublic'
import { canReadSkillEvidence, skillPassportEvidenceWhere } from './skillEvidenceAccess'
import { getPublicKeyInfo, signCanonical } from './signing'
import {
  isUsableSkillVersionForPublicEvidence,
  resolveCurrentSkillVersionForPublicEvidence,
} from './skillVersionPublic'

export type EvidencePackageScope = 'public_skill' | 'enterprise_registry'

function relationId(value: unknown): string | undefined {
  if (!value) return undefined
  return typeof value === 'object' ? String((value as any).id || '') || undefined : String(value)
}

function safeEvidenceFilename(prefix: string, value: unknown) {
  const token = String(value || 'package').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'package'
  return `${prefix}-${token}.json`
}

function evidenceSnapshotSummary(snapshot: any, verify: any) {
  if (!snapshot) return null
  return {
    id: String(snapshot.id || ''),
    targetType: snapshot.targetType || null,
    targetId: snapshot.targetId || null,
    evidenceHash: snapshot.evidenceHash || null,
    payloadHash: snapshot.payloadHash || null,
    keyId: snapshot.keyId || null,
    signedAt: snapshot.signedAt || null,
    verify,
  }
}

function manifestEvidenceSummary(slug: string, passport: any) {
  return {
    checksum: passport?.manifestChecksum || null,
    downloadUrl: `/v1/skills/${encodeURIComponent(slug)}/manifest`,
    note: '证据包不内嵌 manifest 原文，避免把 prompt 或示例随采购包泄露；需要时按下载 URL 获取冻结快照并校验 checksum。',
  }
}

function anchorGuide(snapshot: any) {
  return {
    status: snapshot ? 'snapshot_available' : 'snapshot_missing',
    evidenceAnchorManifest: {
      expectedPath: 'docs/anchors/evidence-snapshots.manifest.json',
      exportCommand: 'npm run worker:export-evidence-anchors',
      verifyCommand: 'npm run worker:verify-evidence-anchors',
    },
    verifyEndpoint: '/v1/anchors/verify',
    timestampRequestEndpoint: '/v1/anchors/timestamp-request',
    timestampIssueEndpoint: '/v1/anchors/timestamp-issue',
    checklist: [
      '保存证据包 JSON、Passport/证书验签 URL、外锚 JSONL 与 manifest',
      '用 /v1/evidence/verify 复核 Passport 证据快照 payloadHash 和签名',
      '用 /v1/anchors/verify 复算 JSONL fileHash、chainHead、manifest 签名和第三方时间戳回执',
      '证据包只含摘要、hash、签名和复核路径，不含 prompt、examples、用户输入输出、token 或 Adapter 补丁正文',
    ],
  }
}

function registryEvidenceSummary(registry: any) {
  if (!registry) return null
  const modelAllowlist = registry.modelAllowlist
  const modelCount = Array.isArray(modelAllowlist)
    ? modelAllowlist.length
    : Array.isArray(modelAllowlist?.models)
      ? modelAllowlist.models.length
      : 0
  return {
    id: String(registry.id || ''),
    name: registry.name || null,
    approvalStatus: registry.approvalStatus || 'pending',
    approvedAt: registry.approvedAt || null,
    skillVersionId: relationId(registry.skillVersion) || null,
    passportId: relationId(registry.passport) || null,
    modelAllowlistCount: modelCount,
    auditPolicyHash: registry.auditPolicy ? evidenceHash(registry.auditPolicy) : null,
    adoptionBaselineHash: registry.adoptionBaseline ? evidenceHash(registry.adoptionBaseline) : null,
    adoptionBaselineCapturedAt: registry.adoptionBaseline?.capturedAt || null,
  }
}

function packagePlaybook(scope: EvidencePackageScope, status?: string | null) {
  const decision = status === 'passed' ? 'accept' : status === 'failed' ? 'reject_or_rework' : 'review'
  return {
    decision,
    customerValue:
      scope === 'enterprise_registry'
        ? '把企业准入要看的 Contract、Passport、证书、证据快照和审计入口打成一个可归档摘要，方便采购/安全/审计复核。'
        : '把公开 Skill 的可信证据打成一个可归档摘要，方便采购前复核、供应商尽调或离线留档。',
    reviewSteps: [
      '先看 certificate.status 与 statusReasons，确认是否正式达标',
      '核对 Contract hash、prompt hash、schema hash 和权限摘要是否符合采用边界',
      '验签 Passport 证据快照与证书签名，再按需复核外锚 manifest',
      '最后用自己的输入或企业私有样例试跑，不把证据包当成永久保证',
    ],
  }
}

function finalizeEvidencePackage(core: any, runtimeEnv: Record<string, string | undefined>) {
  const packageHash = evidenceHash(core)
  const signature = signCanonical({ ...core, packageHash }, runtimeEnv)
  const publicKey = getPublicKeyInfo(runtimeEnv)
  return {
    ...core,
    packageHash,
    packageSignature: signature && publicKey
      ? { algorithm: 'ed25519', keyId: publicKey.keyId, signature }
      : null,
  }
}

async function buildPackageFromParts(args: {
  payload: Payload
  scope: EvidencePackageScope
  skill: any
  passport: any
  version: any | null
  registry?: any | null
  organizationId?: string | null
  adoptionBaselineDrift?: any
}) {
  const slug = String(args.skill?.slug || '')
  const runtimeEnv = await resolveRuntimeEnv(args.payload)
  const publicKey = getPublicKeyInfo(runtimeEnv)
  const [snapshotRes, benchmarkSummary] = await Promise.all([
    args.passport
      ? args.payload.find({
          collection: 'evidence-snapshots' as any,
          where: { and: [{ targetType: { equals: 'skill_passport' } }, { targetId: { equals: String(args.passport.id) } }] },
          limit: 1,
          depth: 0,
          sort: '-createdAt',
          overrideAccess: true,
        })
      : Promise.resolve({ docs: [] as any[] }),
    getSkillBenchmarkEvidence(args.payload, String(args.skill.id)),
  ])
  const snapshot = (snapshotRes.docs as any[])[0] || null
  const evidenceVerify = snapshot ? verifyEvidenceSnapshot(snapshot, publicKey) : null
  const contract = args.version ? publicSkillContract(args.version, { slug }) : null
  const certificate = buildSkillCertificate({
    skill: { id: String(args.skill.id), slug, title: String(args.skill.title || '') },
    passport: args.passport,
    contractSummary: contract,
    benchmarkSummary,
    evidenceSnapshotVerify: evidenceVerify,
  }, runtimeEnv)
  const certificateStatus = certificate.certificate.status
  const adoptionBaselineDrift = args.registry
    ? args.adoptionBaselineDrift || evaluateEnterpriseAdoptionBaselineDrift(args.registry, {
        version: args.version,
        passport: args.passport,
        certificateSummary: {
          status: certificate.certificate.status,
          statusReasons: certificate.certificate.statusReasons,
          certificateHash: certificate.certificate.certificateHash,
          signed: Boolean(certificate.certificateSignature),
        },
      })
    : null

  const core = {
    schemaVersion: 'gewu.evidence.package/v1',
    generatedAt: new Date().toISOString(),
    scope: args.scope,
    subject: {
      skill: { id: String(args.skill.id), slug, title: args.skill.title || null },
      registry: registryEvidenceSummary(args.registry),
      organizationId: args.organizationId || null,
    },
    disclosure: {
      included: ['Contract 摘要/hash', 'Passport 摘要', '达标证书', '证据快照验签摘要', '外锚复核指引'],
      excluded: ['prompt 正文', 'examples 原文', '用户输入输出', 'Adapter 补丁正文', 'token/secret/digest 原文'],
    },
    manifest: manifestEvidenceSummary(slug, args.passport),
    contract,
    passport: publicSkillPassport(args.passport, benchmarkSummary, { slug }),
    certificate,
    evidenceSnapshot: evidenceSnapshotSummary(snapshot, evidenceVerify),
    enterprise: args.registry ? { adoptionBaselineDrift } : null,
    verification: {
      publicKey: publicKey ? { keyId: publicKey.keyId, algorithm: publicKey.algorithm, publicKey: publicKey.publicKey } : null,
      passportEvidenceVerifyUrl: args.passport?.id ? `/v1/evidence/verify?targetType=skill_passport&targetId=${encodeURIComponent(String(args.passport.id))}` : null,
      passportEvidenceVerifyPageUrl: args.passport?.id ? `/verify?targetType=skill_passport&targetId=${encodeURIComponent(String(args.passport.id))}` : null,
      certificateVerifyPageUrl: slug ? certificateVerifyPageUrl(`/v1/skills/${encodeURIComponent(slug)}/certificate`) : null,
      keysUrl: '/v1/keys',
    },
    anchors: anchorGuide(snapshot),
    playbook: packagePlaybook(args.scope, certificateStatus),
  }
  return finalizeEvidencePackage(core, runtimeEnv)
}

export async function buildPublicSkillEvidencePackage(
  payload: Payload,
  args: { slug: string; user?: any },
): Promise<{ ok: true; filename: string; package: any } | { ok: false; status: number; reason: string }> {
  const skills = await payload.find({
    collection: 'skills',
    where: { slug: { equals: args.slug } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const skill = skills.docs[0] as any
  if (!canReadSkillEvidence(skill, args.user)) return { ok: false, status: 404, reason: 'Skill 不存在或不可公开' }

  const passportRes = await payload.find({
    collection: 'skill-passports' as any,
    where: skillPassportEvidenceWhere(skill, args.user) as any,
    limit: 1,
    depth: 0,
    sort: '-lastVerifiedAt',
    overrideAccess: true,
  })
  const passport = passportRes.docs[0] as any
  if (!passport) return { ok: false, status: 404, reason: 'Passport 尚未生成' }
  const version = await resolveCurrentSkillVersionForPublicEvidence(payload, skill)
  const pack = await buildPackageFromParts({ payload, scope: 'public_skill', skill, passport, version })
  return { ok: true, filename: safeEvidenceFilename('gewu-evidence', skill.slug || skill.id), package: pack }
}

export async function buildEnterpriseRegistryEvidencePackage(
  payload: Payload,
  args: { registryId: string; userId: string; userRole?: string },
): Promise<{ ok: true; filename: string; package: any } | { ok: false; status: number; reason: string }> {
  const result = await getEnterpriseRegistryPassport(payload, args)
  if (!result.ok) return { ok: false, status: 403, reason: result.reason }
  const registry = result.registry
  const passport = result.passport
  if (!passport) return { ok: false, status: 404, reason: 'Passport 尚未生成' }
  const skillId = relationId(registry.skill)
  const skill = registry.skill && typeof registry.skill === 'object' && registry.skill.id
    ? registry.skill
    : skillId
      ? await payload.findByID({ collection: 'skills' as any, id: skillId, depth: 0, overrideAccess: true }).catch(() => null)
      : null
  if (!skill) return { ok: false, status: 404, reason: 'Skill 不存在' }

  const registryVersion = registry.skillVersion && typeof registry.skillVersion === 'object' ? registry.skillVersion : null
  const registryVersionId = registryVersion?.id || relationId(registry.skillVersion)
  const version = registryVersionId
    ? registryVersion || await payload.findByID({ collection: 'skill-versions' as any, id: String(registryVersionId), depth: 0, overrideAccess: true }).catch(() => null)
    : await resolveCurrentSkillVersionForPublicEvidence(payload, skill)
  const usableVersion = isUsableSkillVersionForPublicEvidence(skill, version) ? version : null
  const pack = await buildPackageFromParts({
    payload,
    scope: 'enterprise_registry',
    skill,
    passport,
    version: usableVersion,
    registry,
    organizationId: result.organizationId,
  })
  return { ok: true, filename: safeEvidenceFilename('gewu-enterprise-evidence', registry.id), package: pack }
}
