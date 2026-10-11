'use client'

import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PasswordField } from './PasswordField'
import { AuthPage } from './AuthPage'
import { ACCOUNT_HOME } from '@/lib/accountNavigation'

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
        setError(
          data?.error ||
            data?.errors?.[0]?.message ||
            data?.message ||
            '登录失败，请检查账号和密码',
        )
        return
      }

      const meRes = await fetch('/api/users/me', {
        credentials: 'include',
        cache: 'no-store',
      })
      const me = await meRes.json().catch(() => ({}))
      if (!meRes.ok || !me?.user) {
        setError('登录成功但会话未建立，请刷新页面后重试')
        return
      }

      router.replace(ACCOUNT_HOME)
      router.refresh()
    } catch (e: any) {
      setError(e?.message || '网络异常，登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthPage mode="login">
      <form
        method="post"
        action="/v1/auth/login"
        onSubmit={onSubmit}
        className="auth-form"
        aria-busy={loading}
      >
        {error && (
          <div role="alert" className="auth-error">
            {error}
          </div>
        )}
        <Field
          id="login-identifier"
          name="identifier"
          label="用户名或邮箱"
          type="text"
          value={identifier}
          onChange={setIdentifier}
          placeholder="输入用户名或邮箱"
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
        <button type="submit" disabled={loading} className="auth-primary">
          {loading ? '登录中…' : '登录'}
        </button>
      </form>
    </AuthPage>
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
