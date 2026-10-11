'use client'

import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PasswordField } from './PasswordField'
import { AuthPage } from './AuthPage'
import { ACCOUNT_HOME } from '@/lib/accountNavigation'
import {
  validateRegisterInput,
  registerPasswordMinLength,
  registerUsernameMinLength,
  registerUsernameMaxLength,
} from '@/lib/registerValidation'

export function RegisterForm({
  emailRequired,
  initialError,
}: {
  emailRequired: boolean
  initialError?: string
}) {
  const router = useRouter()
  const [form, setForm] = useState({
    email: '',
    username: '',
    password: '',
    inviteCode: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(initialError || null)
  const [accountCreated, setAccountCreated] = useState(false)

  useEffect(() => {
    setError(initialError || null)
  }, [initialError])

  const set = (k: string, v: string) => setForm((s) => ({ ...s, [k]: v }))

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (loading || accountCreated) return
    const inputError = validateRegisterInput({
      ...form,
      username: form.username.trim(),
      email: form.email.trim(),
      emailRequired,
    })
    if (inputError) {
      setError(inputError)
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
      setAccountCreated(true)
      const loginRes = await fetch('/v1/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: data.loginEmail || form.email || form.username,
          password: form.password,
        }),
      })
      const loginData = await loginRes.json().catch(() => ({}))
      if (!loginRes.ok) {
        setError(loginData?.error || '注册成功但自动登录失败，请去登录')
        return
      }

      const meRes = await fetch('/api/users/me', {
        credentials: 'include',
        cache: 'no-store',
      })
      const me = await meRes.json().catch(() => ({}))
      if (!meRes.ok || !me?.user) {
        setError('注册成功但会话未建立，请去登录页重试')
        return
      }

      router.replace(ACCOUNT_HOME)
      router.refresh()
    } catch (e: any) {
      setError(e?.message || '网络异常，注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthPage mode="register">
      {accountCreated ? (
        <div className="auth-created" role="status">
          <p>账号已创建成功。</p>
          <p>
            {error
              ? '自动登录未完成，请用刚才的用户名和密码登录，无需重新注册。'
              : '正在建立登录会话…'}
          </p>
          {error && (
            <Link href="/login" className="account-text-link">
              前往登录 →
            </Link>
          )}
        </div>
      ) : (
        <form
          method="post"
          action="/v1/auth/register"
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
            id="register-username"
            name="username"
            label="用户名"
            value={form.username}
            onChange={(v) => set('username', v)}
            placeholder="2–40 个字符，用于登录"
            autoComplete="username"
            minLength={registerUsernameMinLength}
            maxLength={registerUsernameMaxLength}
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
          <div>
            <PasswordField
              id="register-password"
              name="password"
              label="密码"
              value={form.password}
              onChange={(v) => set('password', v)}
              placeholder="至少 8 位"
              autoComplete="new-password"
              minLength={registerPasswordMinLength}
              describedBy="register-password-hint"
              required
            />
            <p id="register-password-hint" className="auth-hint">
              至少 8 位，建议混合使用字母、数字和符号。
            </p>
          </div>
          <details
            className="auth-invite"
            open={Boolean(form.inviteCode) || undefined}
          >
            <summary>有邀请码？（可选）</summary>
            <Field
              id="register-invite-code"
              name="inviteCode"
              label="邀请码"
              value={form.inviteCode}
              onChange={(v) => set('inviteCode', v)}
              placeholder="没有邀请码也可以注册"
              autoComplete="off"
            />
          </details>
          <button type="submit" disabled={loading} className="auth-primary">
            {loading ? '创建中…' : '创建账号'}
          </button>
        </form>
      )}
    </AuthPage>
  )
}

function getOrCreateDeviceId(): string {
  const key = 'gewu_device_id'
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
  minLength,
  maxLength,
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
  minLength?: number
  maxLength?: number
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
        minLength={minLength}
        maxLength={maxLength}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
      />
    </div>
  )
}
