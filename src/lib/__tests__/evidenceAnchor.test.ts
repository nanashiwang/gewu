import { generateKeyPairSync } from 'crypto'
import { describe, expect, it } from 'vitest'
import { canonicalString } from '@/lib/canonical'
import { getPublicKeyInfo } from '@/lib/signing'
import {
  buildEvidenceAnchorEntry,
  buildEvidenceAnchorManifest,
  signEvidenceAnchorManifest,
  verifyEvidenceAnchorLines,
  verifyEvidenceAnchorManifest,
  verifyEvidenceAnchorManifestSignature,
  type EvidenceAnchorBase,
} from '@/lib/evidenceAnchor'

const base = (overrides: Partial<EvidenceAnchorBase> = {}): EvidenceAnchorBase => ({
  snapshotId: 'snap-1',
  createdAt: '2026-07-08T00:00:00.000Z',
  targetType: 'skill_passport',
  targetId: 'passport-1',
  evidenceHash: 'evidence-hash',
  signedAt: '2026-07-08T00:00:00.000Z',
  payloadHash: 'payload',
  computedHash: 'payload',
  keyId: 'key-1',
  signature: 'sig',
  verifyStatus: 'valid',
  ...overrides,
})

describe('evidenceAnchor — 证据快照外锚哈希链', () => {
  it('为每行生成 entryHash 和连续 chainHash', () => {
    const first = buildEvidenceAnchorEntry(base(), null)
    const second = buildEvidenceAnchorEntry(base({ snapshotId: 'snap-2', targetId: 'failure-1' }), first.chainHash)

    const lines = [canonicalString(first), canonicalString(second)]
    expect(first.previousChainHash).toBeNull()
    expect(second.previousChainHash).toBe(first.chainHash)
    expect(verifyEvidenceAnchorLines(lines)).toMatchObject({ ok: true, chainHead: second.chainHash })
  })

  it('篡改任意行会破坏 entryHash', () => {
    const entry = buildEvidenceAnchorEntry(base(), null)
    const tampered = { ...entry, evidenceHash: 'bad' }
    expect(verifyEvidenceAnchorLines([canonicalString(tampered)])).toMatchObject({
      ok: false,
      reason: '第 1 行 entryHash 不匹配',
    })
  })

  it('拒绝把未通过原始证据快照验签的行作为可信外锚', () => {
    const entry = buildEvidenceAnchorEntry(base({ verifyStatus: 'tampered' }), null)
    expect(verifyEvidenceAnchorLines([canonicalString(entry)])).toMatchObject({
      ok: false,
      reason: '第 1 行证据快照验签状态不是 valid',
    })
  })

  it('删除中间行会破坏链连续性', () => {
    const first = buildEvidenceAnchorEntry(base({ snapshotId: 'snap-1' }), null)
    const second = buildEvidenceAnchorEntry(base({ snapshotId: 'snap-2' }), first.chainHash)
    const third = buildEvidenceAnchorEntry(base({ snapshotId: 'snap-3' }), second.chainHash)

    expect(verifyEvidenceAnchorLines([canonicalString(first), canonicalString(third)])).toMatchObject({
      ok: false,
      reason: '第 2 行 previousChainHash 不连续',
    })
  })

  it('manifest 记录行数、链头和文件哈希', () => {
    const first = buildEvidenceAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z')
    expect(manifest).toMatchObject({ version: 1, entries: 1, chainHead: first.chainHash })
    expect(manifest.fileHash).toHaveLength(64)
    expect(verifyEvidenceAnchorManifest([line], manifest)).toMatchObject({ ok: true })
  })

  it('manifest 文件哈希不一致会被拒绝', () => {
    const first = buildEvidenceAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = { ...buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z'), fileHash: 'bad' }
    expect(verifyEvidenceAnchorManifest([line], manifest)).toMatchObject({
      ok: false,
      reason: 'manifest fileHash 与 JSONL 文件哈希不一致',
    })
  })

  it('manifest 可携带第三方发布与时间戳声明', () => {
    const first = buildEvidenceAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z', {
      publishedTo: [{ target: 'github-release', url: 'https://example.com/anchor.json' }],
      externalTimestamp: {
        provider: 'opentimestamps',
        timestamp: '2026-07-08T00:00:00.000Z',
        receiptHash: 'a'.repeat(64),
      },
    })

    expect(manifest.publishedTo?.[0]).toMatchObject({ target: 'github-release' })
    expect(manifest.externalTimestamp).toMatchObject({ provider: 'opentimestamps' })
    expect(verifyEvidenceAnchorManifest([line], manifest)).toMatchObject({ ok: true })
  })

  it('manifest 第三方时间戳 receiptHash 必须是 sha256', () => {
    const first = buildEvidenceAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z', {
      externalTimestamp: { provider: 'opentimestamps', receiptHash: 'bad' },
    })
    expect(verifyEvidenceAnchorManifest([line], manifest)).toMatchObject({
      ok: false,
      reason: 'manifest externalTimestamp.receiptHash 不是 sha256',
    })
  })

  it('manifest 可用站点 ed25519 私钥自签并验签', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const env = {
      GEWU_SIGNING_KEY: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    }
    const first = buildEvidenceAnchorEntry(base(), null)
    const line = canonicalString(first)
    const manifest = signEvidenceAnchorManifest(buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z'), env)
    const publicKey = getPublicKeyInfo(env)

    expect(manifest.manifestSignature).toMatchObject({ algorithm: 'ed25519', keyId: publicKey?.keyId })
    expect(verifyEvidenceAnchorManifestSignature(manifest, publicKey)).toEqual({ ok: true })
    expect(verifyEvidenceAnchorManifest([line], manifest, publicKey)).toMatchObject({ ok: true })
    expect(verifyEvidenceAnchorManifest([line], { ...manifest, fileHash: 'b'.repeat(64) }, publicKey)).toMatchObject({
      ok: false,
      reason: 'manifest 签名校验失败',
    })
  })
})
