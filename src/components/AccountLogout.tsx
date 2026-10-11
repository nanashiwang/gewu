'use client'

import { useState } from 'react'

export function AccountLogout() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function logout() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/users/logout', {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) throw new Error('退出失败，请重试')
      window.location.assign('/login')
    } catch {
      setError('暂时无法退出，请重试。')
      setBusy(false)
    }
  }
  return (
    <div className="account-logout">
      <button
        type="button"
        className="account-secondary"
        onClick={logout}
        disabled={busy}
      >
        {busy ? '退出中…' : '退出登录'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
