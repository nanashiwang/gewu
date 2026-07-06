'use client'

import { useState } from 'react'

export function PasswordField({
  id,
  name,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  required = false,
}: {
  id: string
  name: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  required?: boolean
}) {
  const [visible, setVisible] = useState(false)
  const buttonLabel = visible ? '隐藏密码' : '显示密码'

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 pr-11 text-sm outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          aria-label={buttonLabel}
          aria-pressed={visible}
          title={buttonLabel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-2 inline-flex w-8 items-center justify-center text-[var(--muted)] transition hover:text-[var(--foreground)] focus:outline-none"
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6A2 2 0 0 0 13.4 13.4" />
      <path d="M9.5 5.3A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.2 3.1" />
      <path d="M6.4 6.4C3.9 8.1 2.5 12 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 4-.8" />
    </svg>
  )
}
