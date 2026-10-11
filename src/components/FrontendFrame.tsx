'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { isDetectorAccountPath } from '@/lib/accountNavigation'
import { DetectorBrand } from './DetectorBrand'

export function FrontendFrame({
  children,
  platformNavigation,
  signedIn,
}: {
  children: ReactNode
  platformNavigation: ReactNode
  signedIn: boolean
}) {
  const pathname = usePathname()
  if (!isDetectorAccountPath(pathname))
    return (
      <>
        {platformNavigation}
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
        <footer className="border-t border-[var(--border)]">
          <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-2 px-4 py-8 text-xs text-[var(--faint)] sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
            <span>© 2026 格物 · v0.1</span>
            <span>Passport · Compatibility · Runner · Enterprise Registry</span>
          </div>
        </footer>
      </>
    )

  return (
    <div className="detector-frame">
      <a className="account-skip" href="#account-main">
        跳到主要内容
      </a>
      <header className="account-header">
        <div className="account-header-inner">
          <DetectorBrand />
          {/* These routes belong to the cohosted detector, so use document navigation. */}
          <nav className="account-public-nav" aria-label="检测站导航">
            <a href="/">检测</a>
            <a href="/leaderboard">质量榜</a>
            <a href="/leaderboard/monitor">模型观测</a>
            <a href="/pricing">模型价格</a>
            <a href="/faq">帮助</a>
          </nav>
          <nav className="account-auth-nav" aria-label="账号导航">
            {signedIn ? (
              <Link
                href="/account"
                className="account-nav-primary"
                aria-current={pathname === '/account' ? 'page' : undefined}
              >
                我的账号
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  aria-current={pathname === '/login' ? 'page' : undefined}
                >
                  登录
                </Link>
                <Link
                  href="/register"
                  className="account-nav-primary"
                  aria-current={pathname === '/register' ? 'page' : undefined}
                >
                  注册
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="account-main" className="account-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="account-footer">
        <div>
          <span>格物 · 公益 API 检测</span>
          <span>
            账号用于站点管理，公开检测无需注册。 <a href="/faq">了解检测</a>
          </span>
        </div>
      </footer>
    </div>
  )
}
