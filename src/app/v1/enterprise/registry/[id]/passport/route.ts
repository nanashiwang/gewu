import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'
import { getEnterpriseRegistryPassport, publicEnterpriseRegistry } from '@/lib/enterprise'
import { verifyEvidenceSnapshot } from '@/lib/evidenceSnapshotVerify'
import { getPublicKeyInfo } from '@/lib/signing'
import { getSkillBenchmarkEvidence } from '@/lib/benchmarkEvidence'
import { buildSkillCertificate } from '@/lib/skillCertificate'
import { publicSkillPassport } from '@/lib/passportPublic'
import { publicSkillContract } from '@/lib/skillContractPublic'
import {
  isUsableSkillVersionForPublicEvidence,
  resolveCurrentSkillVersionForPublicEvidence,
} from '@/lib/skillVersionPublic'

// GET /v1/enterprise/registry/{id}/passport —— 组织内 Skill Passport + 治理状态 + 最新证据验签。
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const result = await getEnterpriseRegistryPassport(payload, {
    userId: user.id as string,
    userRole: (user as any).role,
    registryId: id,
  })
  if (!result.ok) return Response.json({ error: result.reason }, { status: 403 })

  const registry = result.registry
  const passport = result.passport
  const skillId = typeof registry.skill === 'object' ? registry.skill?.id : registry.skill
  const registryVersion = typeof registry.skillVersion === 'object' ? registry.skillVersion : null
  const registryVersionId = registryVersion?.id || registry.skillVersion

  const [snapshotRes, runtimeEnv, benchmarkEvidence, skillDoc] = await Promise.all([
    passport
      ? payload.find({
          collection: 'evidence-snapshots' as any,
          where: { and: [{ targetType: { equals: 'skill_passport' } }, { targetId: { equals: String(passport.id) } }] },
          limit: 1,
          depth: 0,
          sort: '-createdAt',
          overrideAccess: true,
        })
      : Promise.resolve({ docs: [] as any[] }),
    resolveRuntimeEnv(payload),
    skillId ? getSkillBenchmarkEvidence(payload, String(skillId)) : Promise.resolve(null),
    typeof registry.skill === 'object' && registry.skill?.id
      ? Promise.resolve(registry.skill)
      : skillId
        ? payload.findByID({ collection: 'skills', id: String(skillId), depth: 0, overrideAccess: true }).catch(() => null)
        : Promise.resolve(null),
  ])
  const version = skillDoc && registryVersionId
    ? (
        registryVersion?.id
          ? registryVersion
          : await payload.findByID({ collection: 'skill-versions' as any, id: String(registryVersionId), depth: 0, overrideAccess: true }).catch(() => null)
      )
    : skillDoc
      ? await resolveCurrentSkillVersionForPublicEvidence(payload, skillDoc)
      : null
  const contractVersionValid = Boolean(skillDoc && version && isUsableSkillVersionForPublicEvidence(skillDoc, version))
  const publicKey = getPublicKeyInfo(runtimeEnv)
  const snapshot = (snapshotRes.docs as any[])[0] || null
  const evidenceVerify = snapshot ? verifyEvidenceSnapshot(snapshot, publicKey) : null
  const certificate = passport && skillDoc && contractVersionValid
    ? buildSkillCertificate({
        skill: { id: String(skillDoc.id), slug: String(skillDoc.slug || ''), title: String(skillDoc.title || '') },
        passport,
        contractSummary: version ? publicSkillContract(version, { slug: skillDoc.slug }) : null,
        benchmarkSummary: benchmarkEvidence,
        evidenceSnapshotVerify: evidenceVerify,
      }, runtimeEnv)
    : null
  const certificateSummary = certificate
    ? {
        status: certificate.certificate.status,
        statusReasons: certificate.certificate.statusReasons,
        certificateHash: certificate.certificate.certificateHash,
        signed: Boolean(certificate.certificateSignature),
      }
    : passport && skillDoc && !contractVersionValid
      ? { status: 'failed', statusReasons: ['contract_version_invalid'], signed: false }
      : null

  return Response.json({
    organizationId: result.organizationId,
    registry: { ...publicEnterpriseRegistry(registry), certificateSummary },
    passport: passport ? { ...publicSkillPassport(passport, benchmarkEvidence, { slug: skillDoc?.slug }), certificate } : null,
    evidenceSnapshot: snapshot
      ? {
          id: snapshot.id,
          evidenceHash: snapshot.evidenceHash,
          payloadHash: snapshot.payloadHash,
          keyId: snapshot.keyId,
          signedAt: snapshot.signedAt,
          verify: evidenceVerify,
        }
      : null,
    publicKey: publicKey ? { keyId: publicKey.keyId, algorithm: publicKey.algorithm } : null,
  })
}
