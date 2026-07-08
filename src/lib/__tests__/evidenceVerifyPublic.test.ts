import { describe, expect, it } from 'vitest'
import {
  buildEvidenceVerifyQuery,
  buildPublicEvidenceVerifyRows,
  canVerifyEvidenceTarget,
  isPublicEvidenceSnapshot,
  MAX_EVIDENCE_VERIFY_TARGET_ID_LENGTH,
} from '@/lib/evidenceVerifyPublic'
import { evidenceSnapshotHash, type EvidenceSnapshotCore } from '@/lib/evidenceSnapshotVerify'

function fakePayload(docs: Record<string, any>) {
  return {
    findByID: async ({ collection, id }: any) => {
      const key = `${collection}:${id}`
      if (!(key in docs)) throw new Error('not found')
      return docs[key]
    },
  }
}

describe('evidenceVerifyPublic — 公开证据验签查询', () => {
  it('拒绝空参数，避免匿名枚举全量证据快照', () => {
    expect(buildEvidenceVerifyQuery(new URLSearchParams())).toEqual({
      ok: false,
      status: 400,
      error: '缺少 targetType 或 targetId',
    })
    expect(buildEvidenceVerifyQuery(new URLSearchParams({ targetType: 'skill_passport' }))).toMatchObject({
      ok: false,
      status: 400,
    })
  })

  it('只允许公开的证据对象类型，并限制分页上限', () => {
    expect(buildEvidenceVerifyQuery(new URLSearchParams({
      targetType: 'score_snapshot',
      targetId: 'score-1',
    }))).toEqual({ ok: false, status: 400, error: 'targetType 无效' })
    expect(buildEvidenceVerifyQuery(new URLSearchParams({
      targetType: 'skill_passport',
      targetId: 'x'.repeat(MAX_EVIDENCE_VERIFY_TARGET_ID_LENGTH + 1),
    }))).toEqual({ ok: false, status: 400, error: 'targetId 过长' })

    expect(buildEvidenceVerifyQuery(new URLSearchParams({
      targetType: 'skill_passport',
      targetId: 'passport-1',
      limit: '999',
    }))).toEqual({
      ok: true,
      limit: 100,
      where: {
        and: [
          { targetType: { equals: 'skill_passport' } },
          { targetId: { equals: 'passport-1' } },
        ],
      },
    })
  })

  it('只允许 published + public + current Passport 被公开验签', async () => {
    const payload = fakePayload({
      'skill-passports:current-public': { id: 'current-public', status: 'current', skill: 'skill-public' },
      'skill-passports:draft-public': { id: 'draft-public', status: 'draft', skill: 'skill-public' },
      'skill-passports:current-private': { id: 'current-private', status: 'current', skill: 'skill-private' },
      'skills:skill-public': { id: 'skill-public', status: 'published', visibility: 'public' },
      'skills:skill-private': { id: 'skill-private', status: 'published', visibility: 'private' },
    })

    await expect(canVerifyEvidenceTarget(payload, 'skill_passport', 'current-public')).resolves.toBe(true)
    await expect(canVerifyEvidenceTarget(payload, 'skill_passport', 'draft-public')).resolves.toBe(false)
    await expect(canVerifyEvidenceTarget(payload, 'skill_passport', 'current-private')).resolves.toBe(false)
  })

  it('只允许公开失败状态的 FailureCase 被公开验签', async () => {
    const payload = fakePayload({
      'failure-cases:confirmed': { id: 'confirmed', status: 'confirmed' },
      'failure-cases:ignored': { id: 'ignored', status: 'ignored' },
      'failure-cases:private': {
        id: 'private',
        status: 'confirmed',
        skill: { id: 'skill-private', status: 'published', visibility: 'private' },
      },
    })

    await expect(canVerifyEvidenceTarget(payload, 'failure_case', 'confirmed')).resolves.toBe(true)
    await expect(canVerifyEvidenceTarget(payload, 'failure_case', 'ignored')).resolves.toBe(false)
    await expect(canVerifyEvidenceTarget(payload, 'failure_case', 'private')).resolves.toBe(false)
  })

  it('只允许已批准 active Adapter 被公开验签', async () => {
    const payload = fakePayload({
      'adapter-profiles:active': {
        id: 'active',
        status: 'active',
        reviewStatus: 'approved',
        skill: { id: 'skill-public', status: 'published', visibility: 'public' },
      },
      'adapter-profiles:pending': {
        id: 'pending',
        status: 'active',
        reviewStatus: 'pending',
        skill: { id: 'skill-public', status: 'published', visibility: 'public' },
      },
      'adapter-profiles:private': {
        id: 'private',
        status: 'active',
        skill: { id: 'skill-private', status: 'published', visibility: 'private' },
      },
      'adapter-profiles:draft': {
        id: 'draft',
        status: 'draft',
        skill: { id: 'skill-public', status: 'published', visibility: 'public' },
      },
      'adapter-profiles:disabled': {
        id: 'disabled',
        status: 'disabled',
        skill: { id: 'skill-public', status: 'published', visibility: 'public' },
      },
    })

    await expect(canVerifyEvidenceTarget(payload, 'adapter_profile', 'active')).resolves.toBe(true)
    await expect(canVerifyEvidenceTarget(payload, 'adapter_profile', 'pending')).resolves.toBe(false)
    await expect(canVerifyEvidenceTarget(payload, 'adapter_profile', 'private')).resolves.toBe(false)
    await expect(canVerifyEvidenceTarget(payload, 'adapter_profile', 'draft')).resolves.toBe(false)
    await expect(canVerifyEvidenceTarget(payload, 'adapter_profile', 'disabled')).resolves.toBe(false)
  })

  it('外锚导出复用同一公开目标边界，避免导出私有证据快照', async () => {
    const payload = fakePayload({
      'skill-passports:current-public': { id: 'current-public', status: 'current', skill: 'skill-public' },
      'skill-passports:current-private': { id: 'current-private', status: 'current', skill: 'skill-private' },
      'skills:skill-public': { id: 'skill-public', status: 'published', visibility: 'public' },
      'skills:skill-private': { id: 'skill-private', status: 'published', visibility: 'private' },
    })

    await expect(isPublicEvidenceSnapshot(payload, {
      targetType: 'skill_passport',
      targetId: 'current-public',
    })).resolves.toBe(true)
    await expect(isPublicEvidenceSnapshot(payload, {
      targetType: 'skill_passport',
      targetId: 'current-private',
    })).resolves.toBe(false)
  })

  it('公开证据验签响应只返回脱敏 targetSummary，并基于公开摘要验签', () => {
    const core: EvidenceSnapshotCore = {
      targetType: 'failure_case',
      targetId: 'case-1',
      evidenceHash: 'hash-1',
      targetSummary: {
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
      },
      signedAt: '2026-07-08T00:00:00.000Z',
    }
    const rows = buildPublicEvidenceVerifyRows([
      {
        id: 'snap-1',
        ...core,
        targetSummary: {
          modelName: 'qwen-plus',
          modelVersion: '2026-07-01',
          outputText: 'secret output',
          tokenHash: 'secret-token',
        },
        payloadHash: evidenceSnapshotHash(core),
        createdAt: '2026-07-08T00:00:01.000Z',
      },
    ], null)

    expect(rows[0].snapshot.targetSummary).toEqual({
      modelName: 'qwen-plus',
      modelVersion: '2026-07-01',
    })
    expect(rows[0].verify).toMatchObject({
      status: 'unsigned',
      hashValid: true,
    })
  })
})
