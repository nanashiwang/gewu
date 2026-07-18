import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { formatNumber } from '@/lib/format'
import { ConsoleSidebar } from '@/components/ConsoleSidebar'
import { ROLE_LABELS } from '@/components/console/ConsoleUI'
import { STAFF_ROLES } from '@/lib/adminNav'

export const dynamic = 'force-dynamic'

export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const u = user as any
  const isStaff = STAFF_ROLES.includes(u.role)
  const canManageEnterprise = ['admin', 'enterprise_admin'].includes(u.role)

  return (
    <div className="grid gap-6 lg:grid-cols-[210px_1fr]">
      <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
        <div className="card p-4">
          <div className="truncate font-semibold">{u.username}</div>
          <div className="mt-0.5 text-xs text-[var(--muted)]">
            {ROLE_LABELS[u.role] || u.role} · Lv.{u.level}
          </div>
          <div className="mt-2 text-sm font-bold text-[var(--accent)]">
            ⚡ {formatNumber(u.contributionScore)}{' '}
            <span className="text-xs font-normal text-[var(--muted)]">
              贡献分
            </span>
          </div>
          <div className="mt-1 text-sm font-bold text-[var(--accent-2)]">
            ◆ {formatNumber(u.creditBalance)}{' '}
            <span className="text-xs font-normal text-[var(--muted)]">
              credit
            </span>
          </div>
        </div>
        <ConsoleSidebar
          isStaff={isStaff}
          canManageEnterprise={canManageEnterprise}
          canReviewRelays={['admin', 'reviewer'].includes(u.role)}
        />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
