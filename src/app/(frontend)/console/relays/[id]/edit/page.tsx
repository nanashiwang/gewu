import { notFound } from 'next/navigation'
import { RelaySiteForm } from '@/components/relay/RelaySiteForm'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { relationId } from '@/lib/relaySite'
import { relaySiteDto } from '@/lib/relayApi'

export default async function EditRelayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getCurrentUser() as any
  const payload = await getPayloadClient()
  const site = await payload.findByID({ collection: 'relay-sites' as any, id, depth: 1, overrideAccess: true }).catch(() => null) as any
  if (!site || relationId(site.owner) !== String(user.id)) notFound()
  return <div className="mx-auto max-w-4xl space-y-5"><div><h1 className="text-xl font-bold">编辑中转站</h1><p className="mt-1 text-sm text-[var(--muted)]">已公开资料发生实质修改后会重新进入审核；更换 API 域名会重置认领状态。</p></div><RelaySiteForm site={relaySiteDto(site, user)} /></div>
}
