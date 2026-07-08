import { createHash } from 'crypto'
import { canonicalString } from './canonical'
import { verifyEvidenceAnchorManifest, type EvidenceAnchorManifest } from './evidenceAnchor'
import { verifyScoreAnchorManifest, type ScoreAnchorManifest } from './scoreAnchor'

type PublicKeyInfo = { keyId: string; algorithm: string; publicKey: string } | null | undefined
export type AnchorVerifyKind = 'score' | 'evidence'
export type TrustedAnchorPublisher = { target?: string; urlPrefix?: string }
export const MAX_ANCHOR_VERIFY_LINES = 5000
export const MAX_ANCHOR_VERIFY_BYTES = 2_000_000

function approxBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + approxBytes(item), 0)
  if (value == null) return 0
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function normalizeAnchorLines(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((line) => String(line).trim()).filter(Boolean)
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function verifyAnchorManifestBundle(args: {
  kind: AnchorVerifyKind
  jsonl: unknown
  manifest: unknown
  publicKeyInfo?: PublicKeyInfo
  trustedPublishers?: TrustedAnchorPublisher[]
  externalTimestampReceipt?: unknown
}): {
  ok: boolean
  reason: string
  chainHead: string | null
  entries: number
  trustedPublication?: AnchorTrustedPublicationResult
  externalTimestampReceipt?: AnchorReceiptVerifyResult
  assurance: AnchorAssuranceResult
  playbook: AnchorAssurancePlaybook
} {
  const inputBytes = approxBytes(args.jsonl) + approxBytes(args.manifest) + approxBytes(args.externalTimestampReceipt)
  if (inputBytes > MAX_ANCHOR_VERIFY_BYTES) {
    return {
      ok: false,
      reason: '外锚校验输入过大',
      chainHead: null,
      entries: 0,
      assurance: { level: 'invalid', passed: false, reason: '外锚校验输入过大' },
      playbook: anchorAssurancePlaybook({ level: 'invalid', passed: false, reason: '外锚校验输入过大' }),
    }
  }
  const lines = normalizeAnchorLines(args.jsonl)
  if (lines.length > MAX_ANCHOR_VERIFY_LINES) {
    return {
      ok: false,
      reason: '外锚 JSONL 行数超过公开校验上限',
      chainHead: null,
      entries: lines.length,
      assurance: { level: 'invalid', passed: false, reason: '外锚 JSONL 行数超过公开校验上限' },
      playbook: anchorAssurancePlaybook({ level: 'invalid', passed: false, reason: '外锚 JSONL 行数超过公开校验上限' }),
    }
  }
  const manifest = typeof args.manifest === 'string' ? JSON.parse(args.manifest) : args.manifest
  const result = args.kind === 'score'
    ? verifyScoreAnchorManifest(lines, manifest as ScoreAnchorManifest, args.publicKeyInfo)
    : verifyEvidenceAnchorManifest(lines, manifest as EvidenceAnchorManifest, args.publicKeyInfo)
  const trustedPublication = evaluateTrustedAnchorPublication(manifest, args.trustedPublishers)
  const externalTimestampReceipt = evaluateExternalTimestampReceipt(manifest, args.externalTimestampReceipt)
  const assurance = evaluateAnchorAssurance(result, manifest, trustedPublication, externalTimestampReceipt)
  return {
    ...result,
    entries: lines.length,
    trustedPublication,
    externalTimestampReceipt,
    assurance,
    playbook: anchorAssurancePlaybook(assurance),
  }
}


export function anchorTimestampImprint(manifest: any): string {
  const { manifestSignature: _sig, externalTimestamp: _ts, ...core } = manifest || {}
  return createHash('sha256').update(canonicalString(core)).digest('hex')
}

export function buildAnchorTimestampRequest(manifest: any, provider = 'rfc3161') {
  const imprint = anchorTimestampImprint(manifest)
  return {
    customerValue:
      '把外锚 manifest 变成可提交给第三方时间戳服务的请求包；第三方回执原文回填后，只公开校验 receiptHash，不依赖平台自证。',
    provider,
    hashAlgorithm: 'sha256',
    imprint,
    imprintSource: 'manifest_without_signature_or_externalTimestamp',
    manifestSummary: {
      version: manifest?.version ?? null,
      entries: manifest?.entries ?? null,
      chainHead: manifest?.chainHead ?? null,
      fileHash: manifest?.fileHash ?? null,
      generatedAt: manifest?.generatedAt ?? null,
    },
    nextActions: [
      {
        label: '提交第三方时间戳',
        description: '把 imprint 作为 RFC3161 messageImprint 或供应商等价字段提交；不要把私钥交给时间戳服务。',
      },
      {
        label: '保存回执原文',
        description: '拿到第三方 receipt 后原样归档；系统只要求回执原文 sha256 与 manifest.externalTimestamp.receiptHash 一致。',
      },
      {
        label: '回填 manifest',
        description: '把 provider、timestamp、receiptUrl 和 receiptHash 写入 externalTimestamp，再用 /v1/anchors/verify 复核到 external_timestamped。',
      },
    ],
  }
}

export type AnchorTrustedPublicationResult =
  | { status: 'not_declared'; reason: string }
  | { status: 'unconfigured'; reason: string }
  | { status: 'trusted'; reason: string; match: TrustedAnchorPublisher }
  | { status: 'untrusted'; reason: string }

export function parseTrustedAnchorPublishers(value?: string | null): TrustedAnchorPublisher[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.includes('|')) {
        const [target, urlPrefix] = item.split('|').map((x) => x.trim())
        return { target: target || undefined, urlPrefix: urlPrefix || undefined }
      }
      return item.startsWith('http://') || item.startsWith('https://') ? { urlPrefix: item } : { target: item }
    })
}

export function evaluateTrustedAnchorPublication(
  manifest: any,
  trustedPublishers: TrustedAnchorPublisher[] = [],
): AnchorTrustedPublicationResult {
  const publications = Array.isArray(manifest?.publishedTo) ? manifest.publishedTo : []
  if (!publications.length) return { status: 'not_declared', reason: 'manifest 未声明 publishedTo' }
  if (!trustedPublishers.length) return { status: 'unconfigured', reason: '未配置可信发布目标' }
  for (const pub of publications) {
    const target = String(pub?.target || '')
    const url = String(pub?.url || '')
    const match = trustedPublishers.find((trusted) => {
      const targetOk = !trusted.target || trusted.target === target
      const urlOk = !trusted.urlPrefix || url.startsWith(trusted.urlPrefix)
      return targetOk && urlOk
    })
    if (match) return { status: 'trusted', reason: '命中可信发布目标', match }
  }
  return { status: 'untrusted', reason: 'publishedTo 未命中可信发布目标' }
}

export type AnchorReceiptVerifyResult =
  | { status: 'not_declared'; reason: string }
  | { status: 'not_provided'; reason: string }
  | { status: 'valid'; reason: string; receiptHash: string }
  | { status: 'mismatch'; reason: string; expected: string; actual: string }

export type AnchorAssuranceLevel = 'invalid' | 'chain_only' | 'self_signed' | 'trusted_published' | 'external_timestamped'

export type AnchorAssuranceResult = {
  level: AnchorAssuranceLevel
  passed: boolean
  reason: string
}

export type AnchorAssuranceDecision = 'accept' | 'review' | 'archive_only' | 'reject'

export type AnchorAssurancePlaybook = {
  customerValue: string
  decision: AnchorAssuranceDecision
  assuranceChecklist: string[]
  nextActions: string[]
}

export function anchorAssurancePlaybook(assurance: AnchorAssuranceResult): AnchorAssurancePlaybook {
  const decisionByLevel: Record<AnchorAssuranceLevel, AnchorAssuranceDecision> = {
    external_timestamped: 'accept',
    trusted_published: 'review',
    self_signed: 'review',
    chain_only: 'archive_only',
    invalid: 'reject',
  }
  const checklist = [
    '复算 JSONL 行数、fileHash、chainHead 与 manifest 是否一致',
    '校验 manifest ed25519 签名和当前公钥 keyId 是否匹配',
    '核对 publishedTo 是否命中组织认可的可信发布目标',
    '核对 externalTimestamp.receiptHash 是否与上传 receipt 的 sha256 匹配',
  ]
  const nextActionsByLevel: Record<AnchorAssuranceLevel, string[]> = {
    external_timestamped: [
      '可作为采购、审计或第三方复核证据归档',
      '把 manifest、JSONL、receipt 与公钥 keyId 一并保存',
      '后续抽检时用同一接口重新校验 chainHead 和 receiptHash',
    ],
    trusted_published: [
      '先作为可信发布证据进入人工复核',
      '补充外部时间戳 receipt 后重新校验到 external_timestamped',
      '确认发布 URL、组织白名单和 manifest chainHead 一致',
    ],
    self_signed: [
      '先确认站点公钥是否来自可信渠道',
      '补充可信发布目标或第三方时间戳 receipt 后再用于对外承诺',
      '不要把站点自签单独当作第三方背书',
    ],
    chain_only: [
      '仅可证明 JSONL 与 manifest 内部一致，建议只做内部归档',
      '补签 manifest，并配置可信发布目标后重新校验',
      '补充外部时间戳 receipt 以形成不可抵赖时间证据',
    ],
    invalid: [
      '拒绝采用该外锚包，重新导出 JSONL 与 manifest',
      '检查文件是否被截断、篡改或 kind 选择错误',
      '重新获取公钥和 manifest 签名后再提交校验',
    ],
  }
  return {
    customerValue: '把外锚从“平台自称有效”翻译成客户、采购和审计可逐项复核的证据链。',
    decision: decisionByLevel[assurance.level],
    assuranceChecklist: checklist,
    nextActions: nextActionsByLevel[assurance.level],
  }
}

export function evaluateAnchorAssurance(
  manifestResult: { ok: boolean; reason: string },
  manifest: any,
  trustedPublication: AnchorTrustedPublicationResult,
  receipt: AnchorReceiptVerifyResult,
): AnchorAssuranceResult {
  if (!manifestResult.ok) return { level: 'invalid', passed: false, reason: manifestResult.reason }
  if (receipt.status === 'valid') return { level: 'external_timestamped', passed: true, reason: '外锚链、manifest、可信时间戳 receipt 均有效' }
  if (trustedPublication.status === 'trusted') return { level: 'trusted_published', passed: true, reason: '外锚链、manifest 有效，且命中可信发布目标' }
  if (manifest?.manifestSignature?.signature) return { level: 'self_signed', passed: true, reason: '外锚链、manifest 和站点自签名有效' }
  return { level: 'chain_only', passed: true, reason: '外锚链和 manifest 有效，但未形成可信发布或外部时间戳证明' }
}

function receiptText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return JSON.stringify(value)
}

export function evaluateExternalTimestampReceipt(manifest: any, receipt: unknown): AnchorReceiptVerifyResult {
  const expected = String(manifest?.externalTimestamp?.receiptHash || '').trim().toLowerCase()
  if (!expected) return { status: 'not_declared', reason: 'manifest 未声明 externalTimestamp.receiptHash' }
  const text = receiptText(receipt)
  if (!text) return { status: 'not_provided', reason: '未提供外部时间戳 receipt 内容' }
  const actual = createHash('sha256').update(text).digest('hex')
  if (actual !== expected) return { status: 'mismatch', reason: '外部时间戳 receiptHash 不匹配', expected, actual }
  return { status: 'valid', reason: '外部时间戳 receiptHash 匹配', receiptHash: actual }
}
