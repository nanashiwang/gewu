'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type Role = 'creator' | 'acceptor' | 'other'

export function BountyActions({
  bountyId,
  status,
  role,
  loggedIn,
}: {
  bountyId: string
  status: string
  role: Role
  loggedIn: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = useState('')
  const [err, setErr] = useState('')
  const [skillSlug, setSkillSlug] = useState('')

  async function call(action: string, body?: any) {
    setLoading(action)
    setErr('')
    try {
      const res = await fetch(`/v1/bounties/${bountyId}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.ok === false) {
        setErr(d.error || '操作失败')
        return
      }
      router.refresh()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading('')
    }
  }

  if (!loggedIn) {
    return (
      <Link href="/login" className="link-accent text-sm">
        登录后可参与悬赏
      </Link>
    )
  }

  return (
    <div className="space-y-2">
      {err && <div className="text-sm text-[var(--danger)]">{err}</div>}

      {role === 'other' && status === 'open' && (
        <button onClick={() => call('accept')} disabled={loading === 'accept'} className="btn btn-primary w-full">
          {loading === 'accept' ? '认领中…' : '认领此悬赏'}
        </button>
      )}

      {role === 'acceptor' && status === 'accepted' && (
        <div className="space-y-2">
          <input
            value={skillSlug}
            onChange={(e) => setSkillSlug(e.target.value)}
            placeholder="交付的 Skill slug（如 xhs-title-generator）"
            className="input"
          />
          <button
            onClick={() => call('submit', { skillSlug })}
            disabled={loading === 'submit' || !skillSlug}
            className="btn btn-primary w-full"
          >
            {loading === 'submit' ? '提交中…' : '提交交付'}
          </button>
        </div>
      )}

      {role === 'creator' && status === 'submitted' && (
        <button onClick={() => call('complete')} disabled={loading === 'complete'} className="btn btn-primary w-full">
          {loading === 'complete' ? '验收中…' : '验收并发放赏金'}
        </button>
      )}

      {role === 'creator' && ['open', 'accepted', 'submitted'].includes(status) && (
        <button onClick={() => call('cancel')} disabled={loading === 'cancel'} className="btn btn-secondary w-full">
          {loading === 'cancel' ? '取消中…' : '取消悬赏（退还赏金）'}
        </button>
      )}
    </div>
  )
}
