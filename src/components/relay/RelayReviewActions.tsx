'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RelayReviewActions({ siteId }: { siteId: string }) {
  const router = useRouter()
  const [notes, setNotes] = useState('')
  const [pending, setPending] = useState('')
  const [message, setMessage] = useState('')

  async function review(action: 'approve' | 'reject' | 'suspend') {
    setPending(action)
    setMessage('')
    const response = await fetch(`/v1/relay-sites/${siteId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, notes }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) setMessage(data.error || '审核失败')
    else {
      setMessage('审核状态已更新。')
      setNotes('')
      router.refresh()
    }
    setPending('')
  }

  return (
    <div className="space-y-2">
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} className="input min-h-20" placeholder="审核备注；拒绝或暂停时必填" />
      <div className="flex flex-wrap gap-2">
        <button disabled={Boolean(pending)} onClick={() => review('approve')} className="btn btn-primary px-3 py-1.5">通过</button>
        <button disabled={Boolean(pending)} onClick={() => review('reject')} className="btn btn-secondary px-3 py-1.5">拒绝</button>
        <button disabled={Boolean(pending)} onClick={() => review('suspend')} className="btn btn-ghost px-3 py-1.5 text-[var(--danger)]">暂停</button>
      </div>
      {message && <div className="text-xs text-[var(--muted)]">{message}</div>}
    </div>
  )
}
