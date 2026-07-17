import { generateKeyPairSync } from 'crypto'
import { describe, expect, it } from 'vitest'
import { canonicalString } from '@/lib/canonical'
import { getPublicKeyInfo } from '@/lib/signing'
import {
  buildScoreAnchorEntry,
  buildScoreAnchorManifest,
  signScoreAnchorManifest,
  verifyScoreAnchorLines,
  verifyScoreAnchorManifest,
  verifyScoreAnchorManifestSignature,
  type ScoreAnchorBase,
} from '@/lib/scoreAnchor'

const base = (overrides: Partial<ScoreAnchorBase> = {}): ScoreAnchorBase => ({
  snapshotId: 'snap-1',
  createdAt: '2026-07-03T00:00:00.000Z',
  skill: 'skill-1',
  localScore: 90,
  reportCount: 12,
  signedAt: '2026-07-03T00:00:00.000Z',
  payloadHash: 'payload',
  computedHash: 'payload',
  keyId: 'key-1',
  signature: 'sig',
  verifyStatus: 'valid',
  ...overrides,
})

describe('scoreAnchor — 分数快照外锚哈希链', () => {
  it('为每行生成 entryHash 和连续 chainHash', () => {
    const first = buildScoreAnchorEntry(base(), null)
    const second = buildScoreAnchorEntry(base({ snapshotId: 'snap-2', localScore: 91 }), first.chainHash)

    const lines = [canonicalString(first), canonicalString(second)]
    expect(first.previousChainHash).toBeNull()
    expect(second.previousChainHash).toBe(first.chainHash)
    expect(verifyScoreAnchorLines(lines)).toMatchObject({ ok: true, chainHead: second.chainHash })
  })

  it('篡改任意行会破坏 entryHash', () => {
    const entry = buildScoreAnchorEntry(base(), null)
    const tampered = { ...entry, localScore: 99 }
    expect(verifyScoreAnchorLines([canonicalString(tampered)])).toMatchObject({
      ok: false,
      reason: '第 1 行 entryHash 不匹配',
    })
  })

  it('拒绝把未通过原始分数快照验签的行作为可信外锚', () => {
    const entry = buildScoreAnchorEntry(base({ verifyStatus: 'tampered' }), null)
    expect(verifyScoreAnchorLines([canonicalString(entry)])).toMatchObject({
      ok: false,
      reason: '第 1 行分数快照验签状态不是 valid',
    })
  })

  it('删除中间行会破坏链连续性', () => {
    const first = buildScoreAnchorEntry(base({ snapshotId: 'snap-1' }), null)
    const second = buildScoreAnchorEntry(base({ snapshotId: 'snap-2' }), first.chainHash)
    const third = buildScoreAnchorEntry(base({ snapshotId: 'snap-3' }), second.chainHash)

    expect(verifyScoreAnchorLines([canonicalString(first), canonicalString(third)])).toMatchObject({
      ok: false,
      reason: '第 2 行 previousChainHash 不连续',
    })
  })

  it('manifest 记录行数、链头和文件哈希', () => {
    const first = buildScoreAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = buildScoreAnchorManifest([line], '2026-07-03T00:00:00.000Z')
    expect(manifest).toMatchObject({ version: 1, entries: 1, chainHead: first.chainHash })
    expect(manifest.fileHash).toHaveLength(64)
    expect(verifyScoreAnchorManifest([line], manifest)).toMatchObject({ ok: true })
  })

  it('manifest 文件哈希不一致会被拒绝', () => {
    const first = buildScoreAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = { ...buildScoreAnchorManifest([line], '2026-07-03T00:00:00.000Z'), fileHash: 'bad' }
    expect(verifyScoreAnchorManifest([line], manifest)).toMatchObject({
      ok: false,
      reason: 'manifest fileHash 与 JSONL 文件哈希不一致',
    })
  })

  it('manifest 可用站点 ed25519 私钥自签并验签', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const env = {
      GEWU_SIGNING_KEY: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    }
    const first = buildScoreAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = signScoreAnchorManifest(buildScoreAnchorManifest([line], '2026-07-03T00:00:00.000Z'), env)
    const publicKey = getPublicKeyInfo(env)

    expect(manifest.manifestSignature).toMatchObject({ algorithm: 'ed25519', keyId: publicKey?.keyId })
    expect(verifyScoreAnchorManifestSignature(manifest, publicKey)).toEqual({ ok: true })
    expect(verifyScoreAnchorManifest([line], manifest, publicKey)).toMatchObject({ ok: true })
    expect(verifyScoreAnchorManifest([line], { ...manifest, fileHash: 'b'.repeat(64) }, publicKey)).toMatchObject({
      ok: false,
      reason: 'manifest 签名校验失败',
    })
  })
})
