import { notFound } from 'next/navigation'
import { RelaySiteActions } from '@/components/relay/RelaySiteActions'
import { RelaySteps } from '@/components/relay/RelaySteps'
import { RelayDnsRecord } from '@/components/relay/RelayDnsRecord'
import { RelayCheckRefresh } from '@/components/relay/RelayCheckRefresh'
import { RelayTrend } from '@/components/relay/RelayTrend'
import { Section } from '@/components/console/ConsoleUI'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { relationId, relayClaimRecord } from '@/lib/relaySite'
import { relayCheckDto, relaySiteDto } from '@/lib/relayApi'
import { RELAY_CLAIM_LABELS, RELAY_CONTACT_LABELS, RELAY_PROTOCOL_LABELS, RELAY_STATUS_LABELS, relayCheckHasScore, relayStatusClass } from '@/lib/relayUi'

export const dynamic = 'force-dynamic'

export default async function RelayDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getCurrentUser() as any
  const payload = await getPayloadClient()
  const raw = await payload.findByID({ collection: 'relay-sites' as any, id, depth: 1, overrideAccess: true }).catch(() => null) as any
  if (!raw || relationId(raw.owner) !== String(user.id)) notFound()
  const site = relaySiteDto(raw, user) as any
  const history = await payload.find({ collection: 'relay-checks' as any, where: { site: { equals: id } }, sort: '-createdAt', limit: 50, depth: 0, overrideAccess: true })
  const checks = (history.docs as any[]).map((check) => relayCheckDto(check, true))
  const active = checks.some((check) => ['queued', 'running'].includes(String(check.status)))
  const latestScored = checks.find(relayCheckHasScore)
  const latestFinished = checks.find((check) => ['done', 'error'].includes(String(check.status)))
  const latestFinishedAt = latestFinished ? new Date(String(latestFinished.finishedAt || latestFinished.createdAt)).toLocaleString('zh-CN') : '—'
  const claim = relayClaimRecord(site.claimDomain, site.claimToken)
  return (
    <div className="space-y-5">
      <RelaySteps site={site} hasResult={checks.some((check) => check.status === 'done')} />
      <RelayCheckRefresh active={active} />
      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-bold">{site.name}</h1><a href={site.websiteUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-sm text-[var(--accent)]">{site.websiteUrl} ↗</a><div className="mt-2 break-all font-mono text-xs text-[var(--muted)]">{site.apiBaseUrl}</div></div><div className="text-right text-sm"><div className={relayStatusClass(site.status)}>审核：{RELAY_STATUS_LABELS[site.status]}</div><div className={relayStatusClass(site.claimStatus)}>认领：{RELAY_CLAIM_LABELS[site.claimStatus]}</div><div className="mt-2 text-2xl font-bold text-[var(--accent)]">{latestScored ? `${Number(latestScored.score).toFixed(0)} / 100` : '—'}</div><div className="text-xs text-[var(--muted)]">最近有效检测的协议质量分</div></div></div>
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-[var(--muted)]"><span>{RELAY_PROTOCOL_LABELS[site.protocol]}</span><span>{site.model}</span><span>{site.mode === 'quick' ? '快速检测' : '完整检测'}</span><span>{site.hasApiKey ? '已配置检测 Key' : '未配置检测 Key'}</span><span>{site.scheduleEnabled ? `每 ${site.scheduleIntervalHours} 小时自动检测` : '未启用自动检测'}</span></div>
        {site.description && <p className="mt-4 whitespace-pre-wrap text-sm">{site.description}</p>}
        {site.reviewNotes && <div className="mt-4 rounded-lg border border-[var(--warn)]/40 p-3 text-sm"><b>审核反馈：</b>{site.reviewNotes}</div>}
        <div className="mt-5"><RelaySiteActions site={site} hasActiveCheck={active} /></div>
      </div>

      {!['verified', 'manual'].includes(site.claimStatus) && <Section title="站点认领（DNS TXT）"><RelayDnsRecord name={claim.name} value={claim.value} /></Section>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="联系方式"><div className="space-y-2 text-sm">{site.contacts.length ? site.contacts.map((contact: any, index: number) => <div key={index} className="flex justify-between gap-3"><span className="text-[var(--muted)]">{RELAY_CONTACT_LABELS[contact.type] || contact.type}{contact.isPublic ? ' · 公开' : ' · 私密'}</span><span className="break-all text-right">{contact.value}</span></div>) : <span className="text-[var(--muted)]">未填写。</span>}</div></Section>
        <Section title="检测状态"><div className="space-y-2 text-sm"><div className="flex justify-between"><span className="text-[var(--muted)]">下次检测</span><span>{site.nextCheckAt ? new Date(site.nextCheckAt).toLocaleString('zh-CN') : '—'}</span></div><div className="flex justify-between"><span className="text-[var(--muted)]">最近完成时间</span><span>{latestFinishedAt}</span></div><div className="flex justify-between gap-3"><span className="text-[var(--muted)]">最近结论</span><span className="text-right">{!latestFinished ? '暂无报告' : !relayCheckHasScore(latestFinished) ? '证据不足，暂不计分' : latestFinished.verdict === 'passed' ? '已测项目通过' : '存在异常，需复核'}</span></div></div></Section>
      </div>
      <Section title={`检测历史（共 ${history.totalDocs} 条，显示最近 ${checks.length} 条）`}><RelayTrend checks={checks} /></Section>
    </div>
  )
}
