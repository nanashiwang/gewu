'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RelaySiteActions({ site, hasActiveCheck = false }: { site: any; hasActiveCheck?: boolean }) {
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
      setMessage(name === 'check' ? '检测任务已提交，下方会自动更新进度。' : name === 'verify-claim' ? '域名验证成功，现在可以提交审核。' : '已提交审核，请等待运营复核。')
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
    try {
      const response = await fetch(`/v1/relay-sites/${site.id}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || '删除失败')
      router.push('/console/relays')
      router.refresh()
    } catch (error) {
      setMessage((error as Error).message || '网络异常，请重试')
    } finally {
      setPending('')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {!['verified', 'manual'].includes(site.claimStatus) && <button disabled={Boolean(pending)} onClick={() => action('verify-claim')} className="btn btn-primary">{pending === 'verify-claim' ? '验证中…' : '验证 DNS'}</button>}
        {['verified', 'manual'].includes(site.claimStatus) && ['draft', 'rejected'].includes(site.status) && <button disabled={Boolean(pending)} onClick={() => action('submit')} className="btn btn-primary">{pending === 'submit' ? '提交中…' : '提交审核'}</button>}
        {site.status === 'approved' && site.hasApiKey && <button disabled={Boolean(pending) || hasActiveCheck} onClick={() => action('check')} className="btn btn-primary">{hasActiveCheck ? '检测正在进行' : pending === 'check' ? '提交中…' : '立即检测'}</button>}
        {site.status === 'approved' && !site.hasApiKey && <a href={`/console/relays/${site.id}/edit`} className="btn btn-primary">配置检测 Key</a>}
        <a href={`/console/relays/${site.id}/edit`} className="btn btn-secondary">编辑资料</a>
        {['draft', 'rejected'].includes(site.status) && <button disabled={Boolean(pending)} onClick={remove} className="btn btn-ghost text-[var(--danger)]">删除</button>}
      </div>
      {message && <div role="status" className="text-sm text-[var(--muted)]">{message}</div>}
    </div>
  )
}
