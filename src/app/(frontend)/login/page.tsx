import { LoginForm } from '@/components/LoginForm'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'

export const metadata = {
  title: '登录 · 格物',
  description: '登录格物账号，管理自己的中转站。公益 API 检测无需注册。',
  robots: { index: false, follow: false },
}

type LoginPageSearchParams = Record<string, string | string[] | undefined>

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<LoginPageSearchParams>
}) {
  if (await getCurrentUser()) redirect('/account')
  const sp = await searchParams
  const error = Array.isArray(sp.error) ? sp.error[0] : sp.error
  return <LoginForm initialError={error ? error.slice(0, 160) : undefined} />
}
