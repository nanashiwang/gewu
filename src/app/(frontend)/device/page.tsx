import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { DeviceAuthForm } from '@/components/DeviceAuthForm'

export const dynamic = 'force-dynamic'

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const sp = await searchParams
  const user = await getCurrentUser()

  return (
    <div className="mx-auto max-w-md space-y-4 py-8">
      <div>
        <h1 className="text-xl font-semibold">授权 Runner 设备</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          在终端运行 <code className="surface px-1.5 py-0.5 text-xs">gewu login</code> 后，
          把显示的设备码输入这里完成授权。
        </p>
      </div>
      {user ? (
        <DeviceAuthForm initialCode={sp.code} />
      ) : (
        <div className="card p-6 text-sm">
          请先{' '}
          <Link href="/login" className="link-accent">
            登录
          </Link>{' '}
          再授权设备。
        </div>
      )}
    </div>
  )
}
