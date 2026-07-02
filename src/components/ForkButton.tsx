'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// "从改一个现成的开始"：fork 一个已发布 Skill 到自己名下(pending)，成功后跳我的作品。
export function ForkButton({ slug, loggedIn }: { slug: string; loggedIn: boolean }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function fork() {
    if (!loggedIn) {
      router.push('/login')
      return
    }
    if (loading) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(`/v1/skills/${slug}/fork`, { method: 'POST', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        router.push('/console/skills')
        router.refresh()
      } else {
        setErr(data.error || 'fork 失败')
      }
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button onClick={fork} disabled={loading} className="btn btn-secondary w-full" title="复制到我的作品，改成你自己的版本">
        {loading ? 'Fork 中…' : '🍴 从这个改一个'}
      </button>
      {err && <div className="mt-1 text-xs text-[var(--danger)]">{err}</div>}
    </div>
  )
}
