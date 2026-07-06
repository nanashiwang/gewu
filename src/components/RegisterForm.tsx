'use client'

import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PasswordField } from './PasswordField'

export function RegisterForm({
  emailRequired,
  initialError,
}: {
  emailRequired: boolean
  initialError?: string
}) {
  const router = useRouter()
  const [form, setForm] = useState({ email: '', username: '', password: '', inviteCode: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(initialError || null)

  useEffect(() => {
    setError(initialError || null)
  }, [initialError])

  const set = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }))

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!form.username.trim() || !form.password) {
      setError('用户名、密码均为必填')
      return
    }
    if (emailRequired && !form.email.trim()) {
      setError('邮箱为必填')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const deviceId = getOrCreateDeviceId()
      const res = await fetch('/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, deviceId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        setError(data.error || '注册失败')
        return
      }
      const loginRes = await fetch('/v1/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: data.loginEmail || form.email || form.username, password: form.password }),
      })
      const loginData = await loginRes.json().catch(() => ({}))
      if (!loginRes.ok) {
        setError(loginData?.error || '注册成功但自动登录失败，请去登录')
        return
      }

      const meRes = await fetch('/api/users/me', { credentials: 'include', cache: 'no-store' })
      const me = await meRes.json().catch(() => ({}))
      if (!meRes.ok || !me?.user) {
        setError('注册成功但会话未建立，请去登录页重试')
        return
      }

      router.replace('/console')
      router.refresh()
    } catch (e: any) {
      setError(e?.message || '网络异常，注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <h1 className="mb-1 text-xl font-semibold">注册衡术 Hengshu</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        已有账号？
        <Link href="/login" className="ml-1 text-[var(--accent)]">
          去登录
        </Link>
      </p>
      <form
        method="post"
        action="/v1/auth/register"
        onSubmit={onSubmit}
        className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6"
      >
        {error && (
          <div role="alert" className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
        <Field
          id="register-invite-code"
          name="inviteCode"
          label="邀请码（可选）"
          value={form.inviteCode}
          onChange={(v) => set('inviteCode', v)}
          placeholder="有邀请码可填写"
        />
        <Field
          id="register-username"
          name="username"
          label="用户名"
          value={form.username}
          onChange={(v) => set('username', v)}
          placeholder="昵称"
          autoComplete="username"
          required
        />
        <Field
          id="register-email"
          name="email"
          label={emailRequired ? '邮箱' : '邮箱（可选）'}
          type="email"
          value={form.email}
          onChange={(v) => set('email', v)}
          placeholder="you@example.com"
          autoComplete="email"
          required={emailRequired}
        />
        <PasswordField
          id="register-password"
          name="password"
          label="密码"
          value={form.password}
          onChange={(v) => set('password', v)}
          placeholder="至少 8 位"
          autoComplete="new-password"
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-[var(--accent)] px-4 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {loading ? '注册中…' : '注册'}
        </button>
      </form>
    </div>
  )
}

function getOrCreateDeviceId(): string {
  const key = 'hs_device_id'
  try {
    const existing = window.localStorage.getItem(key)
    if (existing) return existing
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    window.localStorage.setItem(key, id)
    return id
  } catch {
    return ''
  }
}

function Field({
  id,
  name,
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  autoComplete,
  required = false,
}: {
  id: string
  name: string
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  required?: boolean
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
      />
    </div>
  )
}
