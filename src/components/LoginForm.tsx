'use client'

import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PasswordField } from './PasswordField'

export function LoginForm({ initialError }: { initialError?: string }) {
  const router = useRouter()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(initialError || null)

  useEffect(() => {
    setError(initialError || null)
  }, [initialError])

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const account = identifier.trim()
    if (!account || !password) {
      setError('账号和密码均为必填')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/v1/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: account, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || data?.errors?.[0]?.message || data?.message || '登录失败，请检查账号和密码')
        return
      }

      const meRes = await fetch('/api/users/me', { credentials: 'include', cache: 'no-store' })
      const me = await meRes.json().catch(() => ({}))
      if (!meRes.ok || !me?.user) {
        setError('登录成功但会话未建立，请刷新页面后重试')
        return
      }

      router.replace('/console')
      router.refresh()
    } catch (e: any) {
      setError(e?.message || '网络异常，登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <h1 className="mb-1 text-xl font-semibold">登录 格物</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        还没有账号？
        <Link href="/register" className="ml-1 text-[var(--accent)]">
          邀请码注册
        </Link>
      </p>
      <form
        method="post"
        action="/v1/auth/login"
        onSubmit={onSubmit}
        className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6"
      >
        {error && (
          <div role="alert" className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
        <Field
          id="login-identifier"
          name="identifier"
          label="邮箱 / 用户名"
          type="text"
          value={identifier}
          onChange={setIdentifier}
          placeholder="you@example.com 或用户名"
          autoComplete="username"
          required
        />
        <PasswordField
          id="login-password"
          name="password"
          label="密码"
          value={password}
          onChange={setPassword}
          placeholder="请输入密码"
          autoComplete="current-password"
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-[var(--accent)] px-4 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {loading ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}

function Field({
  id,
  name,
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
  required = false,
}: {
  id: string
  name: string
  label: string
  type: string
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
