import { createHash, generateKeyPairSync } from 'crypto'
import { describe, expect, it } from 'vitest'
import { canonicalString } from '@/lib/canonical'
import { getPublicKeyInfo } from '@/lib/signing'
import { buildScoreAnchorEntry, buildScoreAnchorManifest, signScoreAnchorManifest } from '@/lib/scoreAnchor'
import { buildEvidenceAnchorEntry, buildEvidenceAnchorManifest, signEvidenceAnchorManifest } from '@/lib/evidenceAnchor'
import {
  evaluateTrustedAnchorPublication,
  evaluateExternalTimestampReceipt,
  MAX_ANCHOR_VERIFY_LINES,
  normalizeAnchorLines,
  parseTrustedAnchorPublishers,
  verifyAnchorManifestBundle,
} from '@/lib/anchorVerify'

const envWithKey = () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { HENGSHU_SIGNING_KEY: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64') }
}

describe('anchorVerify — 公开外锚 bundle 校验', () => {
  it('支持字符串和数组两种 JSONL 输入', () => {
    expect(normalizeAnchorLines(' a\n\n b ')).toEqual(['a', 'b'])
    expect(normalizeAnchorLines([' a ', '', 'b'])).toEqual(['a', 'b'])
  })

  it('限制公开外锚校验输入规模，避免大 JSONL 压垮服务', () => {
    const tooManyLines = Array.from({ length: MAX_ANCHOR_VERIFY_LINES + 1 }, (_, i) => String(i))
    expect(verifyAnchorManifestBundle({
      kind: 'evidence',
      jsonl: tooManyLines,
      manifest: { version: 1, generatedAt: '2026-07-08T00:00:00.000Z', entries: 0, chainHead: null, fileHash: 'x' },
    })).toMatchObject({
      ok: false,
      reason: '外锚 JSONL 行数超过公开校验上限',
      entries: MAX_ANCHOR_VERIFY_LINES + 1,
      assurance: { level: 'invalid', passed: false },
    })

    expect(verifyAnchorManifestBundle({
      kind: 'evidence',
      jsonl: 'x'.repeat(2_000_001),
      manifest: {},
    })).toMatchObject({
      ok: false,
      reason: '外锚校验输入过大',
      entries: 0,
      assurance: { level: 'invalid', passed: false },
    })
  })

  it('校验分数外锚 JSONL + 自签 manifest', () => {
    const env = envWithKey()
    const entry = buildScoreAnchorEntry({
      snapshotId: 's1',
      skill: 'skill-1',
      localScore: 90,
      reportCount: 2,
      signedAt: '2026-07-08T00:00:00.000Z',
      computedHash: 'hash',
      verifyStatus: 'valid',
    }, null)
    const line = canonicalString(entry)
    const manifest = signScoreAnchorManifest(buildScoreAnchorManifest([line], '2026-07-08T00:00:00.000Z'), env)
    const result = verifyAnchorManifestBundle({ kind: 'score', jsonl: `${line}\n`, manifest, publicKeyInfo: getPublicKeyInfo(env) })
    expect(result).toMatchObject({ ok: true, entries: 1, chainHead: entry.chainHash })
  })

  it('校验证据外锚 JSONL + 自签 manifest', () => {
    const env = envWithKey()
    const entry = buildEvidenceAnchorEntry({
      snapshotId: 'e1',
      targetType: 'skill_passport',
      targetId: 'passport-1',
      evidenceHash: 'ehash',
      signedAt: '2026-07-08T00:00:00.000Z',
      computedHash: 'ehash',
      verifyStatus: 'valid',
    }, null)
    const line = canonicalString(entry)
    const manifest = signEvidenceAnchorManifest(buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z'), env)
    const result = verifyAnchorManifestBundle({ kind: 'evidence', jsonl: [line], manifest: JSON.stringify(manifest), publicKeyInfo: getPublicKeyInfo(env) })
    expect(result).toMatchObject({ ok: true, entries: 1, chainHead: entry.chainHash })
  })

  it('识别可信发布目标，形成可信网络声明', () => {
    const trusted = parseTrustedAnchorPublishers('github-release|https://github.com/acme/hengshu/releases/, https://mirror.example.com/anchors/')
    expect(trusted).toEqual([
      { target: 'github-release', urlPrefix: 'https://github.com/acme/hengshu/releases/' },
      { urlPrefix: 'https://mirror.example.com/anchors/' },
    ])
    const manifest = {
      publishedTo: [{ target: 'github-release', url: 'https://github.com/acme/hengshu/releases/download/v1/evidence.manifest.json' }],
    }
    expect(evaluateTrustedAnchorPublication(manifest, trusted)).toMatchObject({ status: 'trusted' })
    expect(evaluateTrustedAnchorPublication({ publishedTo: [{ target: 'paste', url: 'https://evil.example/a' }] }, trusted)).toMatchObject({
      status: 'untrusted',
    })
  })

  it('输出外锚可信等级：自签、可信发布、外部时间戳逐级增强', () => {
    const env = envWithKey()
    const receipt = 'ots receipt bytes'
    const receiptHash = createHash('sha256').update(receipt).digest('hex')
    const entry = buildEvidenceAnchorEntry({
      snapshotId: 'e1',
      targetType: 'skill_passport',
      targetId: 'passport-1',
      evidenceHash: 'ehash',
      signedAt: '2026-07-08T00:00:00.000Z',
      computedHash: 'ehash',
      verifyStatus: 'valid',
    }, null)
    const line = canonicalString(entry)
    const manifest = signEvidenceAnchorManifest(buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z', {
      publishedTo: [{ target: 'github-release', url: 'https://github.com/acme/hengshu/releases/download/v1/evidence.manifest.json' }],
      externalTimestamp: { provider: 'ots', receiptHash },
    }), env)

    expect(verifyAnchorManifestBundle({
      kind: 'evidence',
      jsonl: [line],
      manifest,
      publicKeyInfo: getPublicKeyInfo(env),
    }).assurance).toMatchObject({ level: 'self_signed', passed: true })

    expect(verifyAnchorManifestBundle({
      kind: 'evidence',
      jsonl: [line],
      manifest,
      publicKeyInfo: getPublicKeyInfo(env),
      trustedPublishers: [{ target: 'github-release', urlPrefix: 'https://github.com/acme/hengshu/releases/' }],
    }).assurance).toMatchObject({ level: 'trusted_published', passed: true })

    expect(verifyAnchorManifestBundle({
      kind: 'evidence',
      jsonl: [line],
      manifest,
      publicKeyInfo: getPublicKeyInfo(env),
      trustedPublishers: [{ target: 'github-release', urlPrefix: 'https://github.com/acme/hengshu/releases/' }],
      externalTimestampReceipt: receipt,
    })).toMatchObject({
      assurance: { level: 'external_timestamped', passed: true },
      playbook: {
        decision: 'accept',
        customerValue: expect.stringContaining('客户、采购和审计'),
        assuranceChecklist: expect.arrayContaining([
          '复算 JSONL 行数、fileHash、chainHead 与 manifest 是否一致',
          '核对 externalTimestamp.receiptHash 是否与上传 receipt 的 sha256 匹配',
        ]),
        nextActions: expect.arrayContaining(['可作为采购、审计或第三方复核证据归档']),
      },
    })
  })

  it('按可信等级返回客户可执行决策，且不泄漏 receipt 原文', () => {
    const env = envWithKey()
    const receipt = 'do not leak receipt body'
    const receiptHash = createHash('sha256').update(receipt).digest('hex')
    const entry = buildEvidenceAnchorEntry({
      snapshotId: 'e2',
      targetType: 'adapter_profile',
      targetId: 'adapter-1',
      evidenceHash: 'adapter-evidence-hash',
      signedAt: '2026-07-08T00:00:00.000Z',
      computedHash: 'adapter-evidence-hash',
      verifyStatus: 'valid',
    }, null)
    const line = canonicalString(entry)
    const manifest = signEvidenceAnchorManifest(buildEvidenceAnchorManifest([line], '2026-07-08T00:00:00.000Z', {
      externalTimestamp: { provider: 'ots', receiptHash },
    }), env)

    const result = verifyAnchorManifestBundle({
      kind: 'evidence',
      jsonl: [line],
      manifest,
      publicKeyInfo: getPublicKeyInfo(env),
      externalTimestampReceipt: receipt,
    })

    expect(result.playbook.decision).toBe('accept')
    expect(JSON.stringify(result)).not.toContain(receipt)
  })

  it('可校验外部时间戳 receipt 内容 hash', () => {
    const receipt = 'ots receipt bytes'
    const receiptHash = createHash('sha256').update(receipt).digest('hex')
    expect(evaluateExternalTimestampReceipt({ externalTimestamp: { receiptHash } }, receipt)).toMatchObject({
      status: 'valid',
      receiptHash,
    })
    expect(evaluateExternalTimestampReceipt({ externalTimestamp: { receiptHash } }, 'tampered')).toMatchObject({
      status: 'mismatch',
    })
  })
})
