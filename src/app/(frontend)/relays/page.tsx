import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { relaySiteDto } from '@/lib/relayApi'
import {
  FIRST_PARTY_RELAY_SNAPSHOT,
  VERIDROP_RELAY_SNAPSHOT,
  type ExternalRelaySnapshotSite,
} from '@/lib/relaySnapshots'
import { RELAY_PROTOCOL_LABELS } from '@/lib/relayUi'

export const dynamic = 'force-dynamic'

function ExternalSiteCard({
  site,
  tone = 'reference',
}: {
  site: ExternalRelaySnapshotSite
  tone?: 'reference' | 'risk'
}) {
  const scoreClass = tone === 'risk' ? 'text-amber-700' : 'text-[var(--accent)]'

  return (
    <a
      href={site.sourceUrl}
      target="_blank"
      rel="noreferrer"
      className="card p-5 transition-colors hover:border-[var(--accent)]"
    >
      <div className="flex justify-between gap-3">
        <div>
          <div className="text-xs text-[var(--muted)]">源榜第 {site.sourceRank} 名</div>
          <h3 className="mt-1 font-semibold">{site.domain}</h3>
          <div className="mt-1 text-xs text-[var(--muted)]">
            {site.protocols.map((protocol) => RELAY_PROTOCOL_LABELS[protocol]).join(' · ')}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-bold ${scoreClass}`}>{site.sourceScore}</div>
          <div className="text-xs text-[var(--muted)]">Veridrop 综合分</div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-xs text-[var(--muted)]">
        <span>{site.reportCount} 次公开检测</span>
        <span>最近 {site.lastCheckedAt} ↗</span>
      </div>
      {site.dataQualityNote ? (
        <p className="mt-3 text-xs leading-5 text-amber-700">数据说明：{site.dataQualityNote}</p>
      ) : null}
    </a>
  )
}

export default async function RelayDirectoryPage() {
  const payload = await getPayloadClient()
  const result = await payload.find({
    collection: 'relay-sites' as any,
    where: { status: { equals: 'approved' } },
    sort: '-lastScore,-updatedAt',
    limit: 100,
    depth: 1,
    overrideAccess: true,
  })
  const sites = (result.docs as any[]).map((site) => relaySiteDto(site) as any)

  return (
    <div className="space-y-10">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--hero-from)] p-8">
        <h1 className="text-2xl font-bold">中转站质量档案</h1>
        <p className="mt-2 max-w-3xl text-[var(--muted)]">
          格物实测、站点认领资料与第三方公开快照分区展示；不同来源的评分口径不混排，也不代表商业担保。
        </p>
      </div>

      <section className="space-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">自营中转实测</h2>
            <span className="rounded-full bg-[var(--accent)]/15 px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
              {FIRST_PARTY_RELAY_SNAPSHOT.disclosure}
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {FIRST_PARTY_RELAY_SNAPSHOT.methodology}
          </p>
        </div>
        <article className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">{FIRST_PARTY_RELAY_SNAPSHOT.name}</h3>
              <a
                href={FIRST_PARTY_RELAY_SNAPSHOT.websiteUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[var(--accent)]"
              >
                访问站点 ↗
              </a>
            </div>
            <span className="text-xs text-[var(--muted)]">检测于 2026-07-18</span>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {FIRST_PARTY_RELAY_SNAPSHOT.tests.map((test) => (
              <div
                key={`${test.protocol}-${test.model}`}
                className="rounded-xl border border-[var(--border)] p-4"
              >
                <div className="flex justify-between gap-3">
                  <div>
                    <div className="text-xs text-[var(--muted)]">
                      {RELAY_PROTOCOL_LABELS[test.protocol]}
                    </div>
                    <div className="mt-1 font-mono text-sm">{test.model}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-[var(--accent)]">
                      {test.score.toFixed(1)}
                    </div>
                    <div className="text-xs text-[var(--muted)]">{test.verdict}</div>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-5 text-[var(--muted)]">{test.summary}</p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">已认领站点</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            只展示已完成所有权认领、人工审核并进入格物持续检测的站点。
          </p>
        </div>
        {sites.length === 0 ? (
          <div className="card p-6 text-sm text-[var(--muted)]">暂无已审核中转站。</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sites.map((site) => (
              <Link
                key={site.id}
                href={`/relays/${site.slug}`}
                className="card p-5 transition-colors hover:border-[var(--accent)]"
              >
                <div className="flex justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{site.name}</h2>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      {RELAY_PROTOCOL_LABELS[site.protocol]} · {site.model}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-[var(--accent)]">
                      {site.lastScore == null ? '—' : Number(site.lastScore).toFixed(0)}
                    </div>
                    <div className="text-xs text-[var(--muted)]">
                      {site.lastGrade || '未检测'}
                    </div>
                  </div>
                </div>
                <p className="mt-3 line-clamp-3 text-sm text-[var(--muted)]">
                  {site.description || '暂无简介'}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">第三方红榜参考</h2>
            <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)]">
              已排除源榜前 10 名
            </span>
          </div>
          <p className="mt-1 max-w-4xl text-sm leading-6 text-[var(--muted)]">
            {VERIDROP_RELAY_SNAPSHOT.sourceName} 于 {VERIDROP_RELAY_SNAPSHOT.capturedAt}{' '}
            的固定快照，不是格物实测分。{VERIDROP_RELAY_SNAPSHOT.referenceMethod}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {VERIDROP_RELAY_SNAPSHOT.referenceSites.map((site) => (
            <ExternalSiteCard key={site.domain} site={site} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="rounded-2xl border border-amber-300/70 bg-amber-50/70 p-5">
          <h2 className="text-xl font-semibold text-amber-950">第三方风险观察（黑榜）</h2>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-amber-900">
            {VERIDROP_RELAY_SNAPSHOT.riskMethod}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {VERIDROP_RELAY_SNAPSHOT.riskSites.map((site) => (
            <ExternalSiteCard key={site.domain} site={site} tone="risk" />
          ))}
        </div>
        <p className="text-xs leading-5 text-[var(--muted)]">
          证据不足未列入：{VERIDROP_RELAY_SNAPSHOT.insufficientEvidence[0].domain}（
          {VERIDROP_RELAY_SNAPSHOT.insufficientEvidence[0].reportCount} 次检测）。第三方分数会受样本量与贝叶斯校正影响；低分不能直接解释为“质量差”或“性价比低”，价格也未纳入本快照。
        </p>
      </section>

      <section className="rounded-2xl border border-[var(--border)] p-5 text-sm text-[var(--muted)]">
        <h2 className="font-semibold text-[var(--foreground)]">来源与口径</h2>
        <p className="mt-2 leading-6">{VERIDROP_RELAY_SNAPSHOT.methodology}</p>
        <a
          href={VERIDROP_RELAY_SNAPSHOT.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-[var(--accent)]"
        >
          查看 Veridrop 原始榜单 ↗
        </a>
      </section>
    </div>
  )
}