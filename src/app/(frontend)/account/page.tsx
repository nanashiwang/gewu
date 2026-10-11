import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { AccountLogout } from '@/components/AccountLogout'
import { STAFF_ROLES } from '@/lib/adminNav'

export const metadata = {
  title: '我的账号 · 格物',
  description: '管理格物账号和自己的中转站。',
  robots: { index: false, follow: false },
}

export default async function AccountPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return (
    <section className="account-overview">
      <a href="/" className="account-back">
        ← 返回检测首页
      </a>
      <div className="account-welcome">
        <div>
          <p className="account-eyebrow">我的账号</p>
          <h1>你好，{user.username || '格物用户'}</h1>
          <p>账号已就绪，从这里开始检测或管理站点。</p>
        </div>
        <AccountLogout />
      </div>
      <div className="account-actions">
        <a href="/" className="account-action">
          <span className="account-action-icon" aria-hidden="true">
            ↗
          </span>
          <h2>开始一次检测</h2>
          <p>选择厂商与目标模型，验证接口的实际表现。</p>
          <span className="account-text-link">
            前往检测 <span aria-hidden="true">→</span>
          </span>
        </a>
        <Link href="/console/relays" className="account-action">
          <span className="account-action-icon" aria-hidden="true">
            ⊞
          </span>
          <h2>我的中转站</h2>
          <p>提交站点、验证所有权，并查看检测记录。</p>
          <span className="account-text-link">
            管理站点 <span aria-hidden="true">→</span>
          </span>
        </Link>
      </div>
      <p className="account-note">
        公开检测无需登录。站点认领与公开榜单审核相互独立，注册不会改变评分或自动上榜。
      </p>
      {STAFF_ROLES.includes(user.role) && (
        <Link href="/console" className="account-text-link">
          进入管理控制台 →
        </Link>
      )}
    </section>
  )
}
