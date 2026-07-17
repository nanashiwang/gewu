'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeCertificateUrl } from '@/lib/evidenceLinks'

type VerifyResult = {
  status?: string
  valid?: boolean
  computedHash?: string | null
  hashValid?: boolean
  signatureValid?: boolean
  keyMatch?: boolean
  reason?: string
  publicKey?: { keyId: string; algorithm: string } | null
  auditPlaybook?: {
    customerValue: string
    decision: 'accept' | 'review' | 'reject'
    nextActions: Array<{ label: string; description: string; href?: string | null }>
  }
  certificateSummary?: {
    subject?: { id?: string; slug?: string; title?: string }
    status?: string
    statusReasons?: string[]
    contract?: { version?: string | null; contractHash?: string | null; contractStatus?: string | null; minRunnerVersion?: string | null } | null
    passport?: { id?: string; status?: string; skillClass?: string; trustScore?: number; evidenceHash?: string; evidenceVerifyPageUrl?: string | null }
    benchmark?: {
      total?: number
      passed?: number
      averageScore?: number
      evidenceHash?: string
      cases?: Array<{ caseId?: string; title?: string; total?: number; passed?: number; averageScore?: number; status?: string; models?: string[]; lastRunAt?: string }>
    }
  } | null
  error?: string
}

function statusTone(result: VerifyResult) {
  const certificateStatus = result.certificateSummary?.status
  if ((result.valid || result.status === 'valid') && certificateStatus === 'passed') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
  }
  if ((result.valid || result.status === 'valid') && certificateStatus === 'provisional') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-100'
  }
  if ((result.valid || result.status === 'valid') && certificateStatus === 'failed') {
    return 'border-red-500/30 bg-red-500/10 text-red-100'
  }
  if (result.status === 'unsigned' || result.status === 'key_unavailable') return 'border-amber-500/30 bg-amber-500/10 text-amber-100'
  return 'border-red-500/30 bg-red-500/10 text-red-100'
}

const statusReasonLabels: Record<string, string> = {
  passport_revoked: 'Passport 已撤销',
  skill_rejected: 'Skill 已驳回',
  passport_not_current: 'Passport 还不是当前状态',
  skill_not_verified: 'Skill 尚未进入 verified 档',
  manifest_not_signed: 'manifest 还没有有效签名',
  trust_score_low: 'Passport 可信分不足 60',
  benchmark_missing: '缺少黄金样例基准',
  benchmark_failed: '黄金样例未全部通过',
  evidence_snapshot_missing: '缺少可验签证据快照',
  evidence_snapshot_invalid: '证据快照验签未通过',
}

function statusReasonLabel(reason: string) {
  return statusReasonLabels[reason] || reason
}

function benchmarkCaseStatusLabel(status?: string) {
  if (status === 'passed') return '通过'
  if (status === 'partial') return '部分通过'
  if (status === 'failed') return '未通过'
  if (status === 'no_runs') return '未运行'
  return status || '未知'
}

function resultTitle(result: VerifyResult) {
  if (!result.valid) return '证书验签未通过'
  if (result.certificateSummary?.status === 'passed') return '证书签名有效，且正式达标'
  if (result.certificateSummary?.status === 'provisional') return '证书签名有效，但仍是预备状态'
  if (result.certificateSummary?.status === 'failed') return '证书签名有效，但业务状态未达标'
  return '证书签名有效'
}

function parseJsonField(value: string, label: string) {
  const text = value.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} 不是有效 JSON`)
  }
}

function usablePublicKey(value: any) {
  return value?.publicKey ? value : null
}

function normalizeCertificateInput(raw: any, signatureInput: any, publicKeyInput: any) {
  if (raw?.certificate && typeof raw.certificate === 'object') {
    return {
      certificate: raw.certificate,
      certificateSignature: signatureInput ?? raw.certificateSignature ?? null,
      publicKeyInfo: usablePublicKey(publicKeyInput) ?? usablePublicKey(raw.publicKeyInfo) ?? usablePublicKey(raw.publicKey) ?? null,
    }
  }
  return { certificate: raw, certificateSignature: signatureInput, publicKeyInfo: usablePublicKey(publicKeyInput) }
}

export function CertificateVerifyForm({
  initialCertificateUrl = '',
}: {
  initialCertificateUrl?: string
}) {
  const [certificate, setCertificate] = useState('')
  const [signature, setSignature] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const autoLoaded = useRef(false)
  const safeInitialCertificateUrl = normalizeCertificateUrl(initialCertificateUrl)

  const canSubmit = useMemo(() => certificate.trim().length > 0 && !pending, [certificate, pending])

  async function verifyWithInput(certificateText: string, signatureText = signature, publicKeyText = publicKey) {
    setPending(true)
    setResult(null)
    try {
      const body = normalizeCertificateInput(
        parseJsonField(certificateText, 'certificate'),
        parseJsonField(signatureText, 'certificateSignature'),
        parseJsonField(publicKeyText, 'publicKeyInfo'),
      )
      const response = await fetch('/v1/certificates/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await response.json()) as VerifyResult
      setResult(data)
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : '校验请求失败' })
    } finally {
      setPending(false)
    }
  }

  async function submit() {
    if (!canSubmit) return
    await verifyWithInput(certificate)
  }

  useEffect(() => {
    const url = safeInitialCertificateUrl
    if (autoLoaded.current || !url) return
    autoLoaded.current = true
    setPending(true)
    setResult(null)
    fetch(url)
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data?.error || '证书加载失败')
        const text = JSON.stringify(data, null, 2)
        setCertificate(text)
        return verifyWithInput(text, '', '')
      })
      .catch((error) => {
        setResult({ error: error instanceof Error ? error.message : '证书加载失败' })
        setPending(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent-2)]">Certificate Verifier</p>
        <h2 className="mt-1 text-xl font-semibold">达标证书在线验签</h2>
        <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
          可直接粘贴 /v1/skills/[slug]/certificate 的完整响应，也可粘贴裸 certificate 对象并单独填 certificateSignature；平台会复算 certificateHash、验证 ed25519 签名，并展示证书绑定的 Contract 摘要。
        </p>
        {safeInitialCertificateUrl ? (
          <p className="mt-2 text-xs text-[var(--faint)]">
            已从证书地址自动载入：
            <code className="ml-1 rounded bg-[var(--panel-2)] px-1.5 py-0.5">
              {safeInitialCertificateUrl}
            </code>
          </p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="space-y-1 text-xs text-[var(--muted)]">
          certificate JSON / 裸证书 / 证书 API 完整响应
          <textarea
            value={certificate}
            onChange={(event) => setCertificate(event.target.value)}
            placeholder='{"certificate":{"schemaVersion":"gewu.skill.certificate/v1","certificateHash":"..."},"certificateSignature":{...}}'
            className="h-44 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="space-y-1 text-xs text-[var(--muted)]">
          certificateSignature JSON（可选；完整响应已包含时可不填）
          <textarea
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
            placeholder='{"algorithm":"ed25519","keyId":"...","signature":"..."}'
            className="h-44 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      <label className="mt-3 block space-y-1 text-xs text-[var(--muted)]">
        publicKeyInfo JSON（可选；不填则使用当前站点公钥）
        <textarea
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
          placeholder='{"keyId":"...","algorithm":"ed25519","publicKey":"base64-spki"}'
          className="h-20 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      </label>

      <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? '验签中…' : '开始验签'}
        </button>
        <p className="text-xs text-[var(--faint)]">也可直接调用 POST /v1/certificates/verify 接入采购审计或企业 Registry。</p>
      </div>

      {result ? (
        <div className={`mt-4 rounded-xl border p-4 text-sm ${statusTone(result)}`}>
          {result.error ? (
            <div>验签失败：{result.error}</div>
          ) : (
            <div className="space-y-2">
              <div className="font-semibold">{resultTitle(result)}：{result.reason}</div>
              {result.auditPlaybook ? (
                <div className="rounded-lg border border-current/20 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">客户复核指引</div>
                    <span className="rounded-full border border-current/30 px-2 py-0.5">
                      {result.auditPlaybook.decision === 'accept'
                        ? '可作为准入候选'
                        : result.auditPlaybook.decision === 'reject'
                          ? '建议拒绝'
                          : '需要人工复核'}
                    </span>
                  </div>
                  <p className="mt-2 text-current/80">{result.auditPlaybook.customerValue}</p>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {result.auditPlaybook.nextActions.map((action) => (
                      <div key={action.label} className="rounded border border-current/15 p-2">
                        <div className="font-medium">{action.label}</div>
                        <div className="mt-1 text-current/75">{action.description}</div>
                        {action.href ? (
                          <a href={action.href} className="mt-1 inline-flex text-[var(--accent)] hover:underline">
                            打开关联证据
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="grid gap-2 text-xs md:grid-cols-2 lg:grid-cols-4">
                <div>状态：{result.status || '—'}</div>
                <div>Hash：{result.hashValid ? '有效' : '异常'}</div>
                <div>签名：{result.signatureValid ? '有效' : '未通过'}</div>
                <div>Key：{result.keyMatch ? '匹配' : '未匹配'}</div>
              </div>
              {result.certificateSummary ? (
                <div className="rounded-lg border border-current/20 p-3 text-xs">
                  <div className="font-semibold">证书绑定对象</div>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <div>Skill：{result.certificateSummary.subject?.title || result.certificateSummary.subject?.slug || '—'}</div>
                    <div>证书状态：{result.certificateSummary.status || '—'}</div>
                    <div>Contract：<span className="font-mono">{result.certificateSummary.contract?.contractHash ? `${result.certificateSummary.contract.contractHash.slice(0, 16)}…` : '未绑定'}</span></div>
                    <div>Contract 状态：{result.certificateSummary.contract?.contractStatus || '—'}</div>
                    <div>版本：{result.certificateSummary.contract?.version || '—'}</div>
                    <div>基准：{result.certificateSummary.benchmark?.passed ?? 0}/{result.certificateSummary.benchmark?.total ?? 0}</div>
                  </div>
                  {result.certificateSummary.benchmark?.cases?.length ? (
                    <div className="mt-3 rounded-lg border border-current/20 p-2">
                      <div className="font-semibold">黄金样例逐条摘要</div>
                      <div className="mt-2 space-y-1">
                        {result.certificateSummary.benchmark.cases.slice(0, 5).map((item) => (
                          <div key={item.caseId || item.title} className="flex flex-wrap items-center justify-between gap-2">
                            <span>{item.title || item.caseId || '未命名样例'}</span>
                            <span>
                              {benchmarkCaseStatusLabel(item.status)} · {item.passed ?? 0}/{item.total ?? 0} · score {Number(item.averageScore || 0).toFixed(3)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {result.certificateSummary.passport?.evidenceVerifyPageUrl ? (
                    <a
                      href={result.certificateSummary.passport.evidenceVerifyPageUrl}
                      className="mt-2 inline-flex text-[var(--accent)] hover:underline"
                    >
                      查看 Passport 证据快照
                    </a>
                  ) : null}
                  {result.certificateSummary.statusReasons?.length ? (
                    <div className="mt-2">
                      未达正式达标原因：{result.certificateSummary.statusReasons.map(statusReasonLabel).join(' / ')}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="text-xs">
                computedHash：<span className="font-mono">{result.computedHash ? `${result.computedHash.slice(0, 24)}…` : '—'}</span>
              </div>
              <div className="text-xs">
                公钥：{result.publicKey ? `${result.publicKey.keyId} · ${result.publicKey.algorithm}` : '未配置/未提供'}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
