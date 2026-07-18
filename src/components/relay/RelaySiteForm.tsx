'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'

type Contact = { type: string; value: string; isPublic: boolean }

export function RelaySiteForm({ site }: { site?: any }) {
  const router = useRouter()
  const [contacts, setContacts] = useState<Contact[]>(site?.contacts?.length ? site.contacts : [{ type: 'email', value: '', isPublic: false }])
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')

  const updateContact = (index: number, patch: Partial<Contact>) => {
    setContacts((current) => current.map((contact, i) => (i === index ? { ...contact, ...patch } : contact)))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setMessage('')
    const form = new FormData(event.currentTarget)
    const apiKey = String(form.get('apiKey') || '').trim()
    const clearApiKey = form.get('clearApiKey') === 'on'
    const submittedContacts = contacts.filter((contact) => contact.value.trim())
    if (submittedContacts.length === 0) {
      setMessage('请至少填写一种联系方式，便于格物运营联系你')
      setPending(false)
      return
    }
    const body = {
      name: form.get('name'),
      websiteUrl: form.get('websiteUrl'),
      apiBaseUrl: form.get('apiBaseUrl'),
      description: form.get('description'),
      protocol: form.get('protocol'),
      model: form.get('model'),
      mode: form.get('mode'),
      scheduleEnabled: form.get('scheduleEnabled') === 'on',
      scheduleIntervalHours: Number(form.get('scheduleIntervalHours') || 24),
      contacts: submittedContacts,
      ...(clearApiKey ? { apiKey: '' } : apiKey ? { apiKey } : {}),
    }
    try {
      const response = await fetch(site ? `/v1/relay-sites/${site.id}` : '/v1/relay-sites', {
        method: site ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || '保存失败')
      const id = data.site?.id || site?.id
      router.push(`/console/relays/${id}`)
      router.refresh()
    } catch (error) {
      setMessage((error as Error).message)
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-5 p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>中转站名称</span>
          <input name="name" required minLength={2} maxLength={80} defaultValue={site?.name || ''} className="input" placeholder="例如：格物中转" />
        </label>
        <label className="space-y-1 text-sm">
          <span>官网地址</span>
          <input name="websiteUrl" type="url" required defaultValue={site?.websiteUrl || ''} className="input" placeholder="https://example.com" />
        </label>
        <label className="space-y-1 text-sm md:col-span-2">
          <span>API Base URL</span>
          <input name="apiBaseUrl" type="url" pattern="https://.*" required defaultValue={site?.apiBaseUrl || ''} className="input" placeholder="https://api.example.com/v1" />
          <span className="block text-xs text-[var(--muted)]">必须使用 HTTPS；修改 API 域名后必须重新完成站点认领。</span>
        </label>
        <label className="space-y-1 text-sm">
          <span>主检测协议</span>
          <select name="protocol" defaultValue={site?.protocol || 'openai'} className="input">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Claude / Anthropic</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>主检测模型</span>
          <input name="model" required maxLength={160} defaultValue={site?.model || ''} className="input" placeholder="例如：gpt-5.4" />
        </label>
        <label className="space-y-1 text-sm">
          <span>检测模式</span>
          <select name="mode" defaultValue={site?.mode || 'standard'} className="input">
            <option value="quick">快速</option>
            <option value="standard">标准</option>
            <option value="full">完整</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>API Key</span>
          <input name="apiKey" type="password" autoComplete="new-password" minLength={8} maxLength={500} className="input" placeholder={site?.hasApiKey ? '已加密保存；留空保持不变' : '用于手动/定时检测'} />
          <span className="block text-xs text-[var(--muted)]">服务端 AES-GCM 加密保存，之后不会回显。</span>
          {site?.hasApiKey && <span className="flex items-center gap-2 text-xs text-[var(--danger)]"><input name="clearApiKey" type="checkbox" /> 清除已保存的 API Key，并关闭定时检测</span>}
        </label>
      </div>

      <label className="block space-y-1 text-sm">
        <span>简介</span>
        <textarea name="description" maxLength={2000} defaultValue={site?.description || ''} className="input min-h-28" placeholder="服务范围、计费方式、技术特点等" />
      </label>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">运营联系方式（必填）</div>
            <div className="text-xs text-[var(--muted)]">用于格物运营联系站长，默认仅本人、审核员和管理员可见；只有主动勾选的项目才会公开。</div>
          </div>
          <button type="button" className="btn btn-secondary px-3 py-1.5" disabled={contacts.length >= 5} onClick={() => setContacts((current) => [...current, { type: 'email', value: '', isPublic: false }])}>添加</button>
        </div>
        {contacts.map((contact, index) => (
          <div key={index} className="grid gap-2 rounded-xl border border-[var(--border)] p-3 sm:grid-cols-[140px_1fr_auto_auto] sm:items-center">
            <select value={contact.type} onChange={(event) => updateContact(index, { type: event.target.value })} className="input">
              <option value="email">邮箱</option><option value="qq">QQ</option><option value="wechat">微信</option><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="other">其他</option>
            </select>
            <input value={contact.value} onChange={(event) => updateContact(index, { value: event.target.value })} className="input" maxLength={200} placeholder="请输入联系方式" />
            <label className="flex items-center gap-2 whitespace-nowrap text-xs"><input type="checkbox" checked={contact.isPublic} onChange={(event) => updateContact(index, { isPublic: event.target.checked })} /> 同意公开</label>
            <button type="button" className="text-xs text-[var(--danger)]" onClick={() => setContacts((current) => current.filter((_, i) => i !== index))}>删除</button>
          </div>
        ))}
      </div>

      <div className="grid gap-3 rounded-xl border border-[var(--border)] p-4 sm:grid-cols-[1fr_220px] sm:items-center">
        <label className="flex items-start gap-3 text-sm">
          <input name="scheduleEnabled" type="checkbox" defaultChecked={Boolean(site?.scheduleEnabled)} className="mt-1" />
          <span><b>启用定时检测</b><span className="block text-xs font-normal text-[var(--muted)]">仅审核通过且认领成功后执行。</span></span>
        </label>
        <select name="scheduleIntervalHours" defaultValue={String(site?.scheduleIntervalHours || 24)} className="input">
          <option value="6">每 6 小时</option><option value="12">每 12 小时</option><option value="24">每天</option><option value="72">每 3 天</option><option value="168">每周</option>
        </select>
      </div>

      {message && <div className="rounded-lg border border-[var(--danger)]/40 p-3 text-sm text-[var(--danger)]">{message}</div>}
      <div className="flex gap-3">
        <button disabled={pending} className="btn btn-primary">{pending ? '保存中…' : site ? '保存修改' : '创建中转站'}</button>
        <button type="button" className="btn btn-secondary" onClick={() => router.back()}>返回</button>
      </div>
    </form>
  )
}
