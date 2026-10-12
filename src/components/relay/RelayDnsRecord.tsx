'use client'

import { useState } from 'react'

export function RelayDnsRecord({ name, value }: { name: string; value: string }) {
  const [message, setMessage] = useState('')
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      setMessage(`${label}已复制`)
    } catch {
      setMessage('浏览器未允许复制，请选中记录内容手动复制。')
    }
  }
  return <div>
    <p className="mb-3 text-sm text-[var(--muted)]">在 API 域名的 DNS 管理中添加 TXT 记录，然后点击“验证 DNS”。下方是完整记录名；若 DNS 服务商自动补全域名，只填写它要求的主机记录部分。</p>
    <dl className="space-y-3 text-sm">{[['记录名', name], ['记录值', value]].map(([label, text]) => <div key={label}><dt className="mb-1 text-xs text-[var(--muted)]">{label} · TXT</dt><dd className="relay-dns-value"><code>{text}</code><button type="button" className="btn btn-secondary" onClick={() => copy(text, label)} aria-label={`复制${label}`}>复制</button></dd></div>)}</dl>
    <p role="status" className="mt-2 text-xs text-[var(--muted)]">{message || 'DNS 生效需要时间。验证失败时请核对域名、记录类型和值，稍后重试。'}</p>
  </div>
}
