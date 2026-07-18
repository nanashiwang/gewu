import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { formatNumber } from '@/lib/format'
import { ThemeToggle } from './ThemeToggle'
import { MobileNav } from './MobileNav'
import { NavLink } from './NavLink'

const NAV = [
  { href: '/relays', label: '中转质量' },
  { href: '/skills', label: 'Skill 市场' },
  { href: '/models', label: '模型榜' },
  { href: '/failures', label: '失败库' },
  { href: '/verify', label: '验签' },
  { href: '/rank', label: '可信榜' },
  { href: '/bounties', label: '悬赏区' },
  { href: '/docs', label: '文档' },
]

type ThemeMode = 'light' | 'dark'

export async function SiteNav({ initialTheme = 'dark' }: { initialTheme?: ThemeMode }) {
  const user = await getCurrentUser()
  const u = user as any
  let unread = 0
  if (u) {
    try {
      const payload = await getPayloadClient()
      const res = await payload.count({
        collection: 'notifications',
        where: { and: [{ user: { equals: u.id } }, { read: { equals: false } }] },
        overrideAccess: true,
      })
      unread = res.totalDocs
    } catch {
      /* 未读数失败不影响导航 */
    }
  }
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg-elev)] backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1600px] items-center gap-6 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-sm text-white">
            ⬡
          </span>
          <span className="text-[var(--accent)]">格物</span>
        </Link>

        <MobileNav items={NAV} />

        <nav className="hidden items-center gap-1 text-sm sm:flex">
          {NAV.map((n) => (
            <NavLink key={n.href} href={n.href} label={n.label} />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-sm">
          <ThemeToggle initialTheme={initialTheme} />
          {u ? (
            <>
              <span
                className="hidden items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--accent-2)] sm:inline-flex"
                title="贡献值"
              >
                ⚡ {formatNumber(u.contributionScore)}
              </span>
              <Link
                href="/console/notifications"
                className="relative rounded-lg px-2 py-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--panel-2)] hover:text-[var(--text)]"
                title="通知"
              >
                🔔
                {unread > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[10px] font-medium text-white">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </Link>
              <Link
                href="/console"
                className="rounded-lg px-3 py-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--panel-2)] hover:text-[var(--text)]"
              >
                {u.username || '控制台'}
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-lg px-3 py-1.5 text-[var(--muted)] transition-colors hover:text-[var(--text)]"
              >
                登录
              </Link>
              <Link href="/register" className="btn btn-primary px-4 py-1.5">
                注册
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
