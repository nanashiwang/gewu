'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isDetectorAccountPath } from '@/lib/accountNavigation'

export function ConsoleFrame({
  children,
  sidebar,
}: {
  children: ReactNode
  sidebar: ReactNode
}) {
  const pathname = usePathname()
  if (isDetectorAccountPath(pathname))
    return (
      <div className="account-relays">
        <nav className="account-breadcrumb" aria-label="当前位置">
          <Link href="/account">我的账号</Link>
          <span aria-hidden="true">/</span>
          <Link href="/console/relays">中转站管理</Link>
        </nav>
        {children}
      </div>
    )
  return (
    <div className="grid gap-6 lg:grid-cols-[210px_1fr]">
      {sidebar}
      <div className="min-w-0">{children}</div>
    </div>
  )
}
