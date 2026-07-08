'use client'

import { useMemo, useState } from 'react'

type VerifyResult = {
  kind?: 'score' | 'evidence'
  ok?: boolean
  reason?: string
  chainHead?: string | null
  entries?: number
  publicKey?: { keyId: string; algorithm: string } | null
  trustedPublication?: { status: string; reason: string; match?: { target?: string; urlPrefix?: string } }
  externalTimestampReceipt?: {
    status: string
    reason: string
    receiptHash?: string
    expected?: string
    actual?: string
  }
  assurance?: { level: string; passed: boolean; reason: string }
  playbook?: {
    customerValue: string
    decision: string
    assuranceChecklist: string[]
    nextActions: string[]
  }
  error?: string
}

function parseTrustedPublishers(input: string): Array<{ target?: string; urlPrefix?: string }> | undefined {
  const rows = input
    .split(/\r?\n|,/)
    .map((row) => row.trim())
    .filter(Boolean)
  if (!rows.length) return undefined
  return rows.map((row) => {
    if (row.includes('|')) {
      const [target, urlPrefix] = row.split('|').map((item) => item.trim())
      return { target: target || undefined, urlPrefix: urlPrefix || undefined }
    }
    if (row.startsWith('http://') || row.startsWith('https://')) return { urlPrefix: row }
    return { target: row }
  })
}


function assuranceLabel(level?: string) {
  const labels: Record<string, string> = {
    invalid: '无效',
    chain_only: '仅链有效',
    self_signed: '站点自签',
    trusted_published: '可信发布',
    external_timestamped: '外部时间戳',
  }
  return labels[level || ''] || level || '未知'
}

function assuranceTone(level?: string) {
  if (level === 'external_timestamped') return 'border-emerald-400/40 bg-emerald-400/15 text-emerald-100'
  if (level === 'trusted_published') return 'border-cyan-400/40 bg-cyan-400/15 text-cyan-100'
  if (level === 'self_signed') return 'border-sky-400/40 bg-sky-400/15 text-sky-100'
  if (level === 'chain_only') return 'border-amber-400/40 bg-amber-400/15 text-amber-100'
  return 'border-red-400/40 bg-red-400/15 text-red-100'
}

function statusTone(ok?: boolean, status?: string) {
  if (ok || status === 'trusted' || status === 'valid') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
  if (status === 'not_declared' || status === 'unconfigured' || status === 'not_provided') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-100'
  }
  return 'border-red-500/30 bg-red-500/10 text-red-100'
}

export function AnchorVerifyForm() {
  const [kind, setKind] = useState<'score' | 'evidence'>('score')
  const [jsonl, setJsonl] = useState('')
  const [manifest, setManifest] = useState('')
  const [trustedPublishers, setTrustedPublishers] = useState('')
  const [receipt, setReceipt] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)

  const canSubmit = useMemo(() => jsonl.trim().length > 0 && manifest.trim().length > 0 && !pending, [jsonl, manifest, pending])

  async function submit() {
    if (!canSubmit) return
    setPending(true)
    setResult(null)
    try {
      const response = await fetch('/v1/anchors/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          jsonl,
          manifest,
          trustedPublishers: parseTrustedPublishers(trustedPublishers),
          externalTimestampReceipt: receipt.trim() ? receipt : undefined,
        }),
      })
      const data = (await response.json()) as VerifyResult
      setResult(data)
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : '校验请求失败' })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent-2)]">Anchor Verifier</p>
          <h2 className="mt-1 text-xl font-semibold">外锚包在线校验</h2>
          <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
            粘贴导出的 JSONL 与 manifest，平台会复算行数、链头、文件哈希、manifest 自签名，并给出 chain_only / self_signed / trusted_published / external_timestamped 可信等级。
          </p>
        </div>
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as 'score' | 'evidence')}
          className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
        >
          <option value="score">分数外锚</option>
          <option value="evidence">证据外锚</option>
        </select>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="space-y-1 text-xs text-[var(--muted)]">
          JSONL 内容
          <textarea
            value={jsonl}
            onChange={(event) => setJsonl(event.target.value)}
            placeholder='{"payloadHash":"...","chainHash":"..."}'
            className="h-44 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="space-y-1 text-xs text-[var(--muted)]">
          manifest JSON
          <textarea
            value={manifest}
            onChange={(event) => setManifest(event.target.value)}
            placeholder='{"kind":"score-snapshots","entries":10,"signature":"..."}'
            className="h-44 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <label className="space-y-1 text-xs text-[var(--muted)]">
          临时可信发布目标（可选，每行一个：target 或 target|urlPrefix）
          <textarea
            value={trustedPublishers}
            onChange={(event) => setTrustedPublishers(event.target.value)}
            placeholder="github|https://github.com/org/repo/"
            className="h-20 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="space-y-1 text-xs text-[var(--muted)]">
          外部时间戳 receipt 原文（可选）
          <textarea
            value={receipt}
            onChange={(event) => setReceipt(event.target.value)}
            placeholder="粘贴第三方时间戳回执原文；系统只比对 sha256"
            className="h-20 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? '校验中…' : '开始校验'}
        </button>
        <p className="text-xs text-[var(--faint)]">也可直接调用 POST /v1/anchors/verify 接入 CI 或第三方审计。</p>
      </div>

      {result ? (
        <div className={`mt-4 rounded-xl border p-4 text-sm ${statusTone(result.ok, result.trustedPublication?.status)}`}>
          {result.error ? (
            <div>校验失败：{result.error}</div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="font-semibold">{result.ok ? '外锚包有效' : '外锚包未通过'}：{result.reason}</div>
                {result.assurance ? (
                  <span className={`w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${assuranceTone(result.assurance.level)}`}>
                    可信等级：{assuranceLabel(result.assurance.level)}
                  </span>
                ) : null}
              </div>
              <div className="grid gap-2 text-xs md:grid-cols-2 lg:grid-cols-4">
                <div>类型：{result.kind || kind}</div>
                <div>行数：{result.entries ?? '—'}</div>
                <div>链头：<span className="font-mono">{result.chainHead ? `${result.chainHead.slice(0, 16)}…` : '—'}</span></div>
                <div>公钥：{result.publicKey ? `${result.publicKey.keyId} · ${result.publicKey.algorithm}` : '未配置'}</div>
              </div>
              {result.assurance ? (
                <div className="text-xs">等级说明：{result.assurance.reason}</div>
              ) : null}
              {result.trustedPublication ? (
                <div className="text-xs">可信发布：{result.trustedPublication.status} · {result.trustedPublication.reason}</div>
              ) : null}
              {result.externalTimestampReceipt ? (
                <div className="text-xs">时间戳回执：{result.externalTimestampReceipt.status} · {result.externalTimestampReceipt.reason}</div>
              ) : null}
              {result.playbook ? (
                <div className="rounded-lg border border-current/20 bg-black/10 p-3 text-xs">
                  <div className="font-semibold">复核结论：{result.playbook.decision}</div>
                  <div className="mt-1">客户价值：{result.playbook.customerValue}</div>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="font-semibold">复核清单</div>
                      <ul className="mt-1 list-disc space-y-1 pl-4">
                        {result.playbook.assuranceChecklist.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                    <div>
                      <div className="font-semibold">下一步</div>
                      <ul className="mt-1 list-disc space-y-1 pl-4">
                        {result.playbook.nextActions.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
