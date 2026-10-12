import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getMonitorHealth } from '@/lib/monitorHealth'
import { MonitorHealthPanel } from '@/components/relay/MonitorHealthPanel'
import { isActiveAccount } from '@/access'

export const metadata = { title: '运营监测健康 · 格物' }

export default async function MonitoringPage() {
  const user = await getCurrentUser() as any
  if (!isActiveAccount(user) || !['admin', 'reviewer'].includes(String(user.role))) notFound()
  return <MonitorHealthPanel health={await getMonitorHealth()} />
}
