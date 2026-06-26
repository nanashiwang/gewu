import React from 'react'
import './globals.css'
import { SiteNav } from '@/components/SiteNav'

export const metadata = {
  title: '衡术 Hengshu — Verified AI Skills, Powered by Contribution.',
  description:
    '发现、运行、安装、评测和复用高质量 AI 技能，并通过贡献值机制获得更高权限和资源。',
}

// 在 React 注水前设置主题，避免浅/深色闪烁（FOUC）
const themeInitScript = `(function(){try{var t=localStorage.getItem('skillhub-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`

export default function FrontendLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <SiteNav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
        <footer className="border-t border-[var(--border)]">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-xs text-[var(--faint)] sm:flex-row sm:items-center sm:justify-between">
            <span>© 2026 衡术 Hengshu · v0.1</span>
            <span>Verified AI Skills, Powered by Contribution.</span>
          </div>
        </footer>
      </body>
    </html>
  )
}
