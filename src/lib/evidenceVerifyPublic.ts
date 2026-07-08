import { boundedIntParam } from './queryParams'
import { publicSanitize } from './publicSanitize'
import { verifyEvidenceSnapshot, type PublicKeyInfo } from './evidenceSnapshotVerify'

export const PUBLIC_EVIDENCE_TARGET_TYPES = new Set([
  'skill_passport',
  'failure_case',
  'adapter_profile',
])
export const MAX_EVIDENCE_VERIFY_TARGET_ID_LENGTH = 160

const PUBLIC_FAILURE_STATUSES = new Set(['observed', 'confirmed', 'fixed'])

function relationId(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'object') return String((value as any).id || '') || undefined
  return String(value)
}

function isPublicSkill(value: any) {
  return Boolean(value && typeof value === 'object' && value.status === 'published' && value.visibility === 'public')
}

export function buildEvidenceVerifyQuery(params: URLSearchParams):
  | { ok: true; where: { and: any[] }; limit: number }
  | { ok: false; status: number; error: string } {
  const targetType = params.get('targetType')?.trim()
  const targetId = params.get('targetId')?.trim()
  const limit = boundedIntParam(params, 'limit', 20, 1, 100)

  if (!targetType || !targetId) {
    return { ok: false, status: 400, error: '缺少 targetType 或 targetId' }
  }
  if (!PUBLIC_EVIDENCE_TARGET_TYPES.has(targetType)) {
    return { ok: false, status: 400, error: 'targetType 无效' }
  }
  if (targetId.length > MAX_EVIDENCE_VERIFY_TARGET_ID_LENGTH) {
    return { ok: false, status: 400, error: 'targetId 过长' }
  }
  return {
    ok: true,
    limit,
    where: {
      and: [
        { targetType: { equals: targetType } },
        { targetId: { equals: targetId } },
      ],
    },
  }
}

export async function canVerifyEvidenceTarget(
  payload: { findByID: (args: any) => Promise<any> },
  targetType: string,
  targetId: string,
): Promise<boolean> {
  if (!PUBLIC_EVIDENCE_TARGET_TYPES.has(targetType) || !targetId) return false

  if (targetType === 'skill_passport') {
    const passport = await payload.findByID({
      collection: 'skill-passports' as any,
      id: targetId,
      depth: 0,
      overrideAccess: true,
    }).catch(() => null) as any
    if (!passport || passport.status !== 'current') return false

    const skillId = relationId(passport.skill)
    if (!skillId) return false
    const skill = await payload.findByID({
      collection: 'skills' as any,
      id: skillId,
      depth: 0,
      overrideAccess: true,
    }).catch(() => null) as any

    return Boolean(skill && skill.status === 'published' && skill.visibility === 'public')
  }

  if (targetType === 'failure_case') {
    const failure = await payload.findByID({
      collection: 'failure-cases' as any,
      id: targetId,
      depth: 1,
      overrideAccess: true,
    }).catch(() => null) as any
    return Boolean(
      failure &&
      PUBLIC_FAILURE_STATUSES.has(String(failure.status || 'observed')) &&
      (!failure.skill || isPublicSkill(failure.skill)),
    )
  }

  if (targetType === 'adapter_profile') {
    const adapter = await payload.findByID({
      collection: 'adapter-profiles' as any,
      id: targetId,
      depth: 1,
      overrideAccess: true,
    }).catch(() => null) as any
    const reviewStatus = String(adapter?.reviewStatus || 'approved')
    return Boolean(adapter && adapter.status === 'active' && reviewStatus === 'approved' && isPublicSkill(adapter.skill))
  }

  return false
}

export async function isPublicEvidenceSnapshot(
  payload: { findByID: (args: any) => Promise<any> },
  snapshot: any,
): Promise<boolean> {
  return canVerifyEvidenceTarget(payload, String(snapshot?.targetType || ''), String(snapshot?.targetId || ''))
}

export function buildPublicEvidenceVerifyRows(snapshots: any[], publicKey: PublicKeyInfo | null) {
  return snapshots.map((snapshot) => {
    const targetSummary = snapshot.targetSummary && typeof snapshot.targetSummary === 'object'
      ? publicSanitize(snapshot.targetSummary)
      : null
    const publicSnapshot = {
      id: snapshot.id,
      targetType: snapshot.targetType,
      targetId: snapshot.targetId,
      evidenceHash: snapshot.evidenceHash,
      targetSummary,
      payloadHash: snapshot.payloadHash,
      keyId: snapshot.keyId,
      signature: snapshot.signature,
      signedAt: snapshot.signedAt,
      createdAt: snapshot.createdAt,
    }
    return {
      snapshot: publicSnapshot,
      verify: verifyEvidenceSnapshot(publicSnapshot, publicKey),
    }
  })
}
