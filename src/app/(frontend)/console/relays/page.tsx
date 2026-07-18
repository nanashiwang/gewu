import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { relaySiteDto } from '@/lib/relayApi'
import { RELAY_CLAIM_LABELS, RELAY_PROTOCOL_LABELS, RELAY_STATUS_LABELS, relayStatusClass } from '@/lib/relayUi'

export const dynamic = 'force-dynamic'

export default async function MyRelaysPage() {
  const user = await getCurrentUser() as any
  const payload = await getPayloadClient()
  const result = await payload.find({ collection: 'relay-sites' as any, where: { owner: { equals: user.id } }, sort: '-updatedAt', limit: 100, depth: 1, overrideAccess: true })
  const sites = (result.docs as any[]).map((site) => relaySiteDto(site, user) as any)
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-xl font-bold">我的中转站</h1><p className="mt-1 text-sm text-[var(--muted)]">提交资料、验证域名、申请审核，并查看定时检测趋势。</p></div>
        <Link href="/console/relays/new" className="btn btn-primary">添加中转站</Link>
      </div>
      {sites.length === 0 ? (
        <div className="card p-6 text-sm text-[var(--muted)]">还没有中转站。创建后先完成 DNS 认领，再提交审核。</div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {sites.map((site) => (
            <Link key={site.id} href={`/console/relays/${site.id}`} className="card p-5 transition-colors hover:border-[var(--accent)]">
              <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{site.name}</h2><p className="mt-1 break-all text-xs text-[var(--muted)]">{site.apiBaseUrl}</p></div><div className="text-right text-xs"><div className={relayStatusClass(site.status)}>{RELAY_STATUS_LABELS[site.status]}</div><div className={relayStatusClass(site.claimStatus)}>{RELAY_CLAIM_LABELS[site.claimStatus]}</div></div></div>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]"><span>{RELAY_PROTOCOL_LABELS[site.protocol]}</span><span>{site.model}</span><span>{site.scheduleEnabled ? `每 ${site.scheduleIntervalHours} 小时检测` : '未启用定时检测'}</span><span className="ml-auto text-base font-bold text-[var(--accent)]">{site.lastScore == null ? '—' : `${Number(site.lastScore).toFixed(0)} / ${site.lastGrade}`}</span></div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
