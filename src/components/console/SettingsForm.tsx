'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// 用户设置：自助配置 BYOK 模型网关 Key（绑 Key 后运行走自己额度、免平台代付加价）。
export function SettingsForm({ hasKey, bio }: { hasKey: boolean; bio?: string }) {
  const router = useRouter()
  const [key, setKey] = useState('')
  const [bioVal, setBioVal] = useState(bio || '')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  async function save(payload: Record<string, unknown>, okText: string) {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch('/v1/me/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setMsg({ type: 'ok', text: okText })
        router.refresh()
      } else {
        setMsg({ type: 'err', text: data.error || '保存失败' })
      }
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="text-sm font-medium">模型网关 Key（BYOK）</div>
        <p className="text-xs text-[var(--muted)]">
          绑定你自己的 OpenAI 兼容网关 Key 后，在线运行直连你的额度、免平台代付加价（更省）。
          当前状态：{hasKey ? <span className="text-[var(--accent-2)]">已配置</span> : <span className="text-[var(--muted)]">未配置</span>}
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? '输入新 Key 以替换' : 'sk-...'}
            className="w-72 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => save({ newapiKey: key }, '已保存 Key')}
            disabled={saving || !key.trim()}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            保存
          </button>
          {hasKey && (
            <button
              onClick={() => save({ newapiKey: '' }, '已清除 Key')}
              disabled={saving}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--danger)] hover:text-[var(--danger)]"
            >
              清除
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">简介</div>
        <textarea
          value={bioVal}
          onChange={(e) => setBioVal(e.target.value)}
          rows={3}
          maxLength={500}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={() => save({ bio: bioVal }, '已保存简介')}
          disabled={saving}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          保存简介
        </button>
      </div>

      {msg && (
        <div className={`text-sm ${msg.type === 'ok' ? 'text-[var(--accent-2)]' : 'text-[var(--danger)]'}`}>
          {msg.text}
        </div>
      )}
    </div>
  )
}
