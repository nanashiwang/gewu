'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ADMIN_GROUPS } from '@/lib/adminNav'

const PERSONAL = [
  { href: '/console', label: '概览', exact: true },
  { href: '/console/notifications', label: '通知' },
  { href: '/console/skills', label: '我的作品', exact: true },
  { href: '/console/skills/new', label: '发布 Skill' },
  { href: '/console/installs', label: '已安装 Skill' },
  { href: '/console/runners', label: 'Runner 实例' },
  { href: '/console/runs', label: '运行记录' },
  { href: '/console/contributions', label: '术值流水' },
  { href: '/console/exchange', label: '术值兑换' },
  { href: '/console/favorites', label: '收藏' },
  { href: '/console/invites', label: '邀请码' },
  { href: '/console/settings', label: '设置' },
]

export function ConsoleSidebar({ isStaff }: { isStaff: boolean }) {
  const pathname = usePathname()

  const itemCls = (active: boolean) =>
    `block rounded-lg px-3 py-2 text-sm transition-colors ${
      active
        ? 'bg-[var(--accent)] text-white'
        : 'text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]'
    }`

  return (
    <nav className="space-y-1">
      <div className="px-3 pb-1 text-[11px] uppercase tracking-wide text-[var(--faint)]">个人</div>
      {PERSONAL.map((i) => {
        const active = i.exact ? pathname === i.href : pathname.startsWith(i.href)
        return (
          <Link key={i.href} href={i.href} className={itemCls(active)}>
            {i.label}
          </Link>
        )
      })}

      {isStaff && (
        <>
          <div className="px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-[var(--faint)]">
            管理
          </div>
          {/* 分组为二级标题；组内集合在内容区以横向子标题 Tab 切换 */}
          {ADMIN_GROUPS.map((g) => {
            const href = `/console/admin/${g.items[0].slug}`
            const active = g.items.some((i) => pathname === `/console/admin/${i.slug}`)
            return (
              <Link key={g.key} href={href} className={itemCls(active)}>
                {g.label}
              </Link>
            )
          })}
        </>
      )}
    </nav>
  )
}
