import { notFound } from 'next/navigation'
import { RelayTrend } from '@/components/relay/RelayTrend'
import { Section } from '@/components/console/ConsoleUI'
import { getPayloadClient } from '@/lib/payload'
import { relayCheckDto, relaySiteDto } from '@/lib/relayApi'
import { RELAY_CONTACT_LABELS, RELAY_PROTOCOL_LABELS } from '@/lib/relayUi'

export default async function PublicRelayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const payload = await getPayloadClient()
  const found = await payload.find({ collection: 'relay-sites' as any, where: { and: [{ slug: { equals: slug } }, { status: { equals: 'approved' } }] }, limit: 1, depth: 1, overrideAccess: true })
  const raw = found.docs[0] as any
  if (!raw) notFound()
  const site = relaySiteDto(raw) as any
  const history = await payload.find({ collection: 'relay-checks' as any, where: { and: [{ site: { equals: raw.id } }, { status: { equals: 'done' } }] }, sort: '-finishedAt', limit: 50, depth: 0, overrideAccess: true })
  const checks = (history.docs as any[]).map((check) => relayCheckDto(check))
  return <div className="mx-auto max-w-5xl space-y-5"><div className="card p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-bold">{site.name}</h1><a href={site.websiteUrl} target="_blank" rel="noreferrer" className="mt-1 block text-sm text-[var(--accent)]">访问官网 ↗</a><div className="mt-3 text-sm text-[var(--muted)]">{RELAY_PROTOCOL_LABELS[site.protocol]} · {site.model} · 域名已认领</div></div><div className="text-right"><div className="text-4xl font-bold text-[var(--accent)]">{site.lastScore == null ? '—' : Number(site.lastScore).toFixed(0)}</div><div className="text-sm text-[var(--muted)]">等级 {site.lastGrade || '—'}</div></div></div>{site.description && <p className="mt-5 whitespace-pre-wrap text-sm">{site.description}</p>}</div><div className="grid gap-5 md:grid-cols-2"><Section title="公开联系方式"><div className="space-y-2 text-sm">{site.contacts.length ? site.contacts.map((contact: any, index: number) => <div key={index} className="flex justify-between gap-3"><span className="text-[var(--muted)]">{RELAY_CONTACT_LABELS[contact.type] || contact.type}</span><span className="break-all text-right">{contact.value}</span></div>) : <span className="text-[var(--muted)]">站长未公开联系方式。</span>}</div></Section><Section title="检测摘要"><div className="space-y-2 text-sm"><div className="flex justify-between"><span className="text-[var(--muted)]">检测次数</span><span>{history.totalDocs}</span></div><div className="flex justify-between"><span className="text-[var(--muted)]">最近检测</span><span>{site.lastCheckAt ? new Date(site.lastCheckAt).toLocaleString('zh-CN') : '—'}</span></div><div className="flex justify-between"><span className="text-[var(--muted)]">最近结论</span><span>{site.lastVerdict || '—'}</span></div></div></Section></div><Section title="历史质量趋势"><RelayTrend checks={checks} /></Section></div>
}
