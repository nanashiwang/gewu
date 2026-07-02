'use client'

import { useState } from 'react'

// 换模型一键重跑：私人台账的切换成本核心钩子——用同一历史输入换个模型看效果/成本。
export function RerunButton({ runId, models }: { runId: string; models: string[] }) {
  const [model, setModel] = useState(models[0] || '')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  async function rerun() {
    if (!model || loading) return
    setLoading(true)
    setErr(null)
    setResult(null)
    try {
      const res = await fetch(`/v1/runs/${runId}/rerun`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) setResult(data)
      else setErr((data.errors && data.errors[0]) || data.error || '重跑失败')
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-2 border-t border-[var(--border)] pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[var(--muted)]">换模型重跑：</span>
        {models.length > 0 ? (
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="模型名"
            className="w-40 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs"
          />
        )}
        <button
          onClick={rerun}
          disabled={loading || !model}
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {loading ? '重跑中…' : '重跑'}
        </button>
      </div>
      {err && <div className="mt-1 text-xs text-[var(--danger)]">{err}</div>}
      {result && (
        <div className="mt-2 rounded bg-[var(--panel)] p-2 text-xs">
          <div className="mb-1 text-[var(--muted)]">
            {result.model} · 成本 ¥{Number(result.cost || 0).toFixed(4)}
            {result.savedAmount > 0 ? ` · 省 ¥${Number(result.savedAmount).toFixed(4)}` : ''}
            {result.mocked ? ' · [MOCK]' : ''}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {String(result.output || '（无输出）').slice(0, 4000)}
          </pre>
        </div>
      )}
    </div>
  )
}
