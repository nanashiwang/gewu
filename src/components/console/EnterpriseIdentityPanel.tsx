'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type Org = {
  id: string
  name: string
  slug?: string
  identityPolicy?: any
  identityPlaybook?: any
}

export function EnterpriseIdentityPanel({ organizations }: { organizations: Org[] }) {
  const router = useRouter()
  const [rows, setRows] = useState(organizations)
  const [selected, setSelected] = useState(organizations[0]?.id || '')
  const org = rows.find((o) => o.id === selected)
  const [domains, setDomains] = useState('')
  const [requireSso, setRequireSso] = useState(false)
  const [ssoProvider, setSsoProvider] = useState('')
  const [ssoIssuer, setSsoIssuer] = useState('')
  const [ssoClientId, setSsoClientId] = useState('')
  const [ssoDiscoveryUrl, setSsoDiscoveryUrl] = useState('')
  const [scimBaseUrl, setScimBaseUrl] = useState('')
  const [scimTokenDigest, setScimTokenDigest] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    setRows(organizations)
    setSelected((current) => (organizations.some((o) => o.id === current) ? current : organizations[0]?.id || ''))
  }, [organizations])

  useEffect(() => {
    const policy = org?.identityPolicy || {}
    setDomains(Array.isArray(policy.domainAllowlist) ? policy.domainAllowlist.join(', ') : '')
    setRequireSso(policy.requireSso === true)
    setSsoProvider(policy.sso?.provider || '')
    setSsoIssuer(policy.sso?.issuer || '')
    setSsoClientId(policy.sso?.clientId || '')
    setSsoDiscoveryUrl(policy.sso?.discoveryUrl || '')
    setScimBaseUrl(policy.scim?.baseUrl || '')
    setScimTokenDigest(policy.scim?.tokenDigest || '')
    setMsg(null)
  }, [org?.id])

  async function save() {
    if (!org || saving) return
    setSaving(true)
    setMsg(null)
    const domainAllowlist = domains
      .split(/[ ,\n]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean)
    const identityPolicy: Record<string, unknown> = {}
    if (domainAllowlist.length) identityPolicy.domainAllowlist = domainAllowlist
    if (requireSso) identityPolicy.requireSso = true
    if (ssoProvider || ssoIssuer || ssoClientId || ssoDiscoveryUrl) identityPolicy.sso = { enabled: true, provider: ssoProvider || undefined, issuer: ssoIssuer || undefined, clientId: ssoClientId || undefined, discoveryUrl: ssoDiscoveryUrl || undefined }
    if (scimBaseUrl || scimTokenDigest) identityPolicy.scim = { enabled: true, baseUrl: scimBaseUrl || undefined, tokenDigest: scimTokenDigest || undefined }

    try {
      const res = await fetch('/v1/enterprise/identity', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: org.id, identityPolicy }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setMsg({ type: 'err', text: data.error || '保存失败' })
        return
      }
      setRows((prev) => prev.map((row) => (row.id === org.id ? { ...row, identityPolicy: data.identityPolicy, identityPlaybook: data.identityPlaybook } : row)))
      setMsg({ type: 'ok', text: '身份策略已保存；SSO/SCIM 配置已通过格式校验。' })
      router.refresh()
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  if (rows.length === 0) return <div className="text-sm text-[var(--muted)]">暂无组织。</div>

  return (
    <div className="space-y-4 text-sm">
      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">组织</label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
        >
          {rows.map((o) => (
            <option key={o.id} value={o.id}>{o.name || o.slug || o.id}</option>
          ))}
        </select>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs text-[var(--muted)]">邮箱域白名单</span>
        <input
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          placeholder="example.com, team.io"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
        />
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
          <input type="checkbox" checked={requireSso} onChange={(e) => setRequireSso(e.target.checked)} />
          <span>要求 SSO 登录</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">SSO Provider</span>
          <input
            value={ssoProvider}
            onChange={(e) => setSsoProvider(e.target.value)}
            placeholder="oidc / saml / okta"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">SSO Issuer</span>
          <input
            value={ssoIssuer}
            onChange={(e) => setSsoIssuer(e.target.value)}
            placeholder="https://idp.example.com"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">OIDC Client ID</span>
          <input
            value={ssoClientId}
            onChange={(e) => setSsoClientId(e.target.value)}
            placeholder="gewu-enterprise"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">OIDC Discovery URL</span>
          <input
            value={ssoDiscoveryUrl}
            onChange={(e) => setSsoDiscoveryUrl(e.target.value)}
            placeholder="https://idp.example.com/.well-known/openid-configuration"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--muted)]">SCIM Base URL</span>
          <input
            value={scimBaseUrl}
            onChange={(e) => setScimBaseUrl(e.target.value)}
            placeholder="https://api.example.com/scim"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs text-[var(--muted)]">SCIM Token Digest</span>
        <input
          value={scimTokenDigest}
          onChange={(e) => setScimTokenDigest(e.target.value)}
          placeholder="sha256:..."
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 outline-none focus:border-[var(--accent)]"
        />
        <span className="mt-1 block text-xs text-[var(--faint)]">只保存 token 的 sha256 摘要；SCIM 调用使用 Authorization: Bearer。</span>
      </label>

      {org?.identityPolicy && (
        <details className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
          <summary className="cursor-pointer text-[var(--muted)]">当前身份策略 JSON</summary>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(org.identityPolicy, null, 2)}</pre>
        </details>
      )}

      {org?.identityPlaybook && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
          <div className="font-medium text-[var(--text)]">身份接入指引 · {org.identityPlaybook.decision}</div>
          <p className="mt-1 text-[var(--muted)]">{org.identityPlaybook.customerValue}</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {(org.identityPlaybook.nextActions || []).slice(0, 4).map((action: any) => (
              <div key={action.label} className="rounded-md border border-[var(--border)] bg-[var(--panel)] p-2">
                <div className="font-medium text-[var(--text)]">{action.label}</div>
                <div className="mt-1 text-[var(--muted)]">{action.description}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <button onClick={save} disabled={saving || !org} className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {saving ? '保存中...' : '保存身份策略'}
      </button>
      {msg && <span className={msg.type === 'ok' ? 'ml-3 text-[var(--accent-2)]' : 'ml-3 text-[var(--danger)]'}>{msg.text}</span>}
    </div>
  )
}
