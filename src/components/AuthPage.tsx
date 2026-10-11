import type { ReactNode } from 'react'
import Link from 'next/link'

export function AuthPage({
  mode,
  children,
}: {
  mode: 'login' | 'register'
  children: ReactNode
}) {
  const registering = mode === 'register'
  return (
    <div className="auth-layout">
      <section className="auth-intro" aria-labelledby="auth-intro-title">
        <a href="/" className="account-back">
          ← 返回检测首页
        </a>
        <p className="account-eyebrow">格物账号</p>
        <h1 id="auth-intro-title">
          检测，随时开始。
          <br />
          站点，在这里管理。
        </h1>
        <p className="auth-description">
          格物是独立的公益 API 检测项目。只想验证接口？无需账号，即可开始检测。
        </p>
        <a href="/" className="account-text-link">
          直接开始检测 <span aria-hidden="true">↗</span>
        </a>
        <div className="auth-benefits">
          <h2>注册后，你可以</h2>
          <ul>
            <li>
              <span className="auth-step" aria-hidden="true">
                01
              </span>
              <div>
                <strong>管理自己的中转站</strong>
                <p>提交站点资料，通过 DNS 验证所有权。</p>
              </div>
            </li>
            <li>
              <span className="auth-step" aria-hidden="true">
                02
              </span>
              <div>
                <strong>查看站点检测记录</strong>
                <p>在站点管理中查看检测结果与变化。</p>
              </div>
            </li>
          </ul>
          <p className="auth-fairness">
            注册不等于上榜，公开展示仍须经过审核。
          </p>
        </div>
      </section>
      <section className="auth-card" aria-labelledby="auth-form-title">
        <nav className="auth-tabs" aria-label="登录或注册">
          <Link href="/login" aria-current={!registering ? 'page' : undefined}>
            登录
          </Link>
          <Link
            href="/register"
            aria-current={registering ? 'page' : undefined}
          >
            注册
          </Link>
        </nav>
        <div className="auth-card-heading">
          <h2 id="auth-form-title">
            {registering ? '创建你的格物账号' : '欢迎回到格物'}
          </h2>
          <p>
            {registering
              ? '用一个账号，管理你的站点。'
              : '使用用户名或邮箱，继续管理站点。'}
          </p>
        </div>
        {children}
        <p className="auth-switch">
          {registering ? '已有账号？' : '还没有账号？'}{' '}
          <Link href={registering ? '/login' : '/register'}>
            {registering ? '去登录' : '免费注册'}
          </Link>
        </p>
      </section>
    </div>
  )
}
