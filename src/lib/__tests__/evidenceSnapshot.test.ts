import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalString } from '@/lib/canonical'
import { evidenceSnapshotCore, writeEvidenceSnapshot } from '@/lib/evidenceSnapshot'

describe('evidenceSnapshot — 证据签名快照', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'))
    vi.stubEnv('GEWU_SIGNING_KEY', '')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('生成稳定 core 载荷', () => {
    expect(
      evidenceSnapshotCore({
        targetType: 'skill_passport',
        targetId: 'passport-1',
        evidenceHash: 'abc',
        signedAt: '2026-07-08T00:00:00.000Z',
      }),
    ).toEqual({
      targetType: 'skill_passport',
      targetId: 'passport-1',
      evidenceHash: 'abc',
      signedAt: '2026-07-08T00:00:00.000Z',
    })
  })

  it('core 载荷可携带脱敏公开摘要，用于外锚解释模型版本', () => {
    expect(
      evidenceSnapshotCore({
        targetType: 'adapter_profile',
        targetId: 'adapter-1',
        evidenceHash: 'hash-1',
        signedAt: '2026-07-08T00:00:00.000Z',
        targetSummary: {
          modelName: 'qwen-plus',
          modelVersion: '2026-07-01',
          rawInput: 'secret',
          tokenDigest: 'secret-token',
        },
      }),
    ).toEqual({
      targetType: 'adapter_profile',
      targetId: 'adapter-1',
      evidenceHash: 'hash-1',
      signedAt: '2026-07-08T00:00:00.000Z',
      targetSummary: {
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
      },
    })
  })

  it('无签名密钥时仍写入 append-only 快照', async () => {
    const create = vi.fn(async (args) => ({ id: 'snap-1', ...args.data }))
    const payload = {
      findGlobal: vi.fn(async () => ({})),
      create,
      logger: { warn: vi.fn(), error: vi.fn() },
    } as any

    const result = await writeEvidenceSnapshot(payload, {
      targetType: 'failure_case',
      targetId: 'case-1',
      evidenceHash: 'hash-1',
    })

    const core = evidenceSnapshotCore({
      targetType: 'failure_case',
      targetId: 'case-1',
      evidenceHash: 'hash-1',
      signedAt: '2026-07-08T00:00:00.000Z',
    })
    const payloadHash = createHash('sha256').update(canonicalString(core)).digest('hex')

    expect(result).toMatchObject({ id: 'snap-1', targetType: 'failure_case', targetId: 'case-1', evidenceHash: 'hash-1' })
    expect(create).toHaveBeenCalledWith({
      collection: 'evidence-snapshots',
      overrideAccess: true,
      data: {
        targetType: 'failure_case',
        targetId: 'case-1',
        evidenceHash: 'hash-1',
        payloadHash,
        keyId: undefined,
        signature: undefined,
        signedAt: '2026-07-08T00:00:00.000Z',
      },
    })
  })

  it('写入快照时保存脱敏 targetSummary 并纳入 payloadHash', async () => {
    const create = vi.fn(async (args) => ({ id: 'snap-1', ...args.data }))
    const payload = {
      findGlobal: vi.fn(async () => ({})),
      create,
      logger: { warn: vi.fn(), error: vi.fn() },
    } as any

    await writeEvidenceSnapshot(payload, {
      targetType: 'failure_case',
      targetId: 'case-1',
      evidenceHash: 'hash-1',
      targetSummary: { modelName: 'qwen-plus', primaryModelVersion: '2026-07-01', outputText: 'secret' },
    })

    const core = evidenceSnapshotCore({
      targetType: 'failure_case',
      targetId: 'case-1',
      evidenceHash: 'hash-1',
      signedAt: '2026-07-08T00:00:00.000Z',
      targetSummary: { modelName: 'qwen-plus', primaryModelVersion: '2026-07-01' },
    })
    const payloadHash = createHash('sha256').update(canonicalString(core)).digest('hex')

    expect(create).toHaveBeenCalledWith({
      collection: 'evidence-snapshots',
      overrideAccess: true,
      data: expect.objectContaining({
        targetSummary: { modelName: 'qwen-plus', primaryModelVersion: '2026-07-01' },
        payloadHash,
      }),
    })
  })

  it('无 evidenceHash 时不写快照', async () => {
    const payload = { create: vi.fn() } as any

    await expect(
      writeEvidenceSnapshot(payload, { targetType: 'adapter_profile', targetId: 'adapter-1', evidenceHash: null }),
    ).resolves.toBeNull()
    expect(payload.create).not.toHaveBeenCalled()
  })
})
