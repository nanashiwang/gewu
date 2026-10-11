import { RegisterForm } from '@/components/RegisterForm'
import { getPayloadClient } from '@/lib/payload'
import { getRegistrationEmailRequired } from '@/lib/siteSettings'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'

export const metadata = {
  title: '注册 · 格物',
  description: '创建格物账号，认领和管理自己的中转站。公益 API 检测无需注册。',
  robots: { index: false, follow: false },
}

type RegisterPageSearchParams = Record<string, string | string[] | undefined>

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<RegisterPageSearchParams>
}) {
  if (await getCurrentUser()) redirect('/account')
  const sp = await searchParams
  const error = Array.isArray(sp.error) ? sp.error[0] : sp.error
  const payload = await getPayloadClient()
  const emailRequired = await getRegistrationEmailRequired(payload)
  return (
    <RegisterForm
      emailRequired={emailRequired}
      initialError={error ? error.slice(0, 160) : undefined}
    />
  )
}
