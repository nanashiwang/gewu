'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RelaySiteActions({ site }: { site: any }) {
  const router = useRouter()
  const [pending, setPending] = useState('')
  const [message, setMessage] = useState('')

  async function action(name: 'verify-claim' | 'submit' | 'check') {
    setPending(name)
    setMessage('')
    try {
      const response = await fetch(`/v1/relay-sites/${site.id}/${name}`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || '操作失败')
      setMessage(name === 'check' ? '检测任务已提交，定时任务会同步结果。' : '操作成功。')
      router.refresh()
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setPending('')
    }
  }

  async function remove() {
    if (!window.confirm(`确定删除“${site.name}”吗？`)) return
    setPending('delete')
    setMessage('')
    const response = await fetch(`/v1/relay-sites/${site.id}`, { method: 'DELETE' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      setMessage(data.error || '删除失败')
      setPending('')
      return
    }
    router.push('/console/relays')
    router.refresh()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {!['verified', 'manual'].includes(site.claimStatus) && <button disabled={Boolean(pending)} onClick={() => action('verify-claim')} className="btn btn-primary">{pending === 'verify-claim' ? '验证中…' : '验证 DNS'}</button>}
        {['verified', 'manual'].includes(site.claimStatus) && !['pending', 'approved'].includes(site.status) && <button disabled={Boolean(pending)} onClick={() => action('submit')} className="btn btn-primary">{pending === 'submit' ? '提交中…' : '提交审核'}</button>}
        {site.status === 'approved' && site.hasApiKey && <button disabled={Boolean(pending)} onClick={() => action('check')} className="btn btn-secondary">{pending === 'check' ? '提交中…' : '立即检测'}</button>}
        <a href={`/console/relays/${site.id}/edit`} className="btn btn-secondary">编辑资料</a>
        {['draft', 'rejected'].includes(site.status) && <button disabled={Boolean(pending)} onClick={remove} className="btn btn-ghost text-[var(--danger)]">删除</button>}
      </div>
      {message && <div className="text-sm text-[var(--muted)]">{message}</div>}
    </div>
  )
}
