import type { ReactNode } from 'react'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { isActiveAccount } from '@/access'

export const metadata = {
  title: '中转站管理 · 格物',
  description: '认领自己的中转站，提交审核并查看检测记录。',
  robots: { index: false, follow: false },
}

export default async function RelayAccountLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await getCurrentUser()
  const staff = isActiveAccount(user) && ['admin', 'reviewer'].includes(String(user.role))
  return <>{staff && <nav aria-label="运营管理" className="mb-5 flex flex-wrap gap-4 text-sm text-[var(--accent)]"><Link href="/console/relays/review">站点审核</Link><Link href="/console/relays/monitoring">监测健康</Link></nav>}{children}</>
}
