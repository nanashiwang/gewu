import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { formatCost, formatLatency, timeAgo } from '@/lib/format'
import { Section, Empty } from '@/components/console/ConsoleUI'
import { Pagination } from '@/components/Pagination'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 30

const TITLES: Record<string, string> = {
  installs: '已安装 Skill',
  runners: 'Runner 实例',
  runs: '运行记录',
  contributions: '术值流水',
  favorites: '收藏',
  invites: '邀请码',
}

export default async function ConsoleSection({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { section } = await params
  if (!(section in TITLES)) notFound()

  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page || '1', 10) || 1)
  const user = await getCurrentUser()
  const u = user as any
  const payload = await getPayloadClient()
  const uid = u.id as string

  let title = TITLES[section]
  let body: React.ReactNode = null
  let totalPages = 1

  if (section === 'installs') {
    const installs = await payload.find({
      collection: 'skill-installs',
      where: { and: [{ user: { equals: uid } }, { status: { equals: 'installed' } }] },
      depth: 1,
      limit: PAGE_SIZE,
      page,
      sort: '-lastUsedAt',
      overrideAccess: true,
    })
    title = `已安装 Skill（${installs.totalDocs}）`
    totalPages = installs.totalPages || 1

    // 待更新：比对已装 checksum 与当前最新制品
    const outdated = new Set<string>()
    for (const inst of installs.docs as any[]) {
      const skillId = typeof inst.skill === 'object' ? inst.skill?.id : inst.skill
      const art = await payload.find({
        collection: 'skill-artifacts',
        where: { and: [{ skill: { equals: skillId } }, { format: { equals: 'yaml' } }] },
        sort: '-createdAt',
        limit: 1,
        overrideAccess: true,
      })
      const current = (art.docs[0] as any)?.checksum
      if (current && inst.installedChecksum && current !== inst.installedChecksum) outdated.add(inst.id)
    }

    body =
      installs.docs.length === 0 ? (
        <Empty>
          还没装。用 <code className="surface px-1 text-[11px]">hengshu install &lt;slug&gt;</code> 安装到本地。
        </Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(installs.docs as any[]).map((inst) => {
            const s = typeof inst.skill === 'object' ? inst.skill : null
            return (
              <li key={inst.id} className="flex items-center justify-between py-2">
                <span className="min-w-0 truncate">
                  {s ? (
                    <Link href={`/skills/${s.slug}`} className="hover:text-[var(--accent)]">
                      {s.title}
                    </Link>
                  ) : (
                    'Skill'
                  )}
                  <span className="ml-2 text-xs text-[var(--muted)]">v{inst.installedVersion}</span>
                </span>
                {outdated.has(inst.id) ? (
                  <span className="shrink-0 rounded border border-[var(--warn)] px-1.5 py-0.5 text-[11px] text-[var(--warn)]">
                    待更新
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-[var(--muted)]">{timeAgo(inst.lastUsedAt)}</span>
                )}
              </li>
            )
          })}
        </ul>
      )
  } else if (section === 'runners') {
    const runners = await payload.find({
      collection: 'runner-clients',
      where: { user: { equals: uid } },
      limit: PAGE_SIZE,
      page,
      sort: '-lastSeenAt',
      overrideAccess: true,
    })
    title = `Runner 实例（${runners.totalDocs}）`
    totalPages = runners.totalPages || 1
    body =
      runners.docs.length === 0 ? (
        <Empty>
          还没绑定设备。终端 <code className="surface px-1 text-[11px]">hengshu login</code> 登录。
        </Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(runners.docs as any[]).map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <span className="font-mono text-xs">{String(r.runnerId).slice(0, 13)}…</span>
              <span className="text-xs text-[var(--muted)]">
                {r.os}/{r.arch} · {r.trustedLevel} · {timeAgo(r.lastSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      )
  } else if (section === 'runs') {
    const runs = await payload.find({
      collection: 'skill-runs',
      where: { user: { equals: uid } },
      depth: 1,
      limit: PAGE_SIZE,
      page,
      sort: '-createdAt',
      overrideAccess: true,
    })
    title = `运行记录（${runs.totalDocs}）`
    totalPages = runs.totalPages || 1
    body =
      runs.docs.length === 0 ? (
        <Empty>
          还没有运行记录。去{' '}
          <Link href="/skills" className="text-[var(--accent)]">
            Skill 市场
          </Link>{' '}
          跑一个吧。
        </Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(runs.docs as any[]).map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <span className="min-w-0 truncate">
                {typeof r.skill === 'object' ? r.skill?.title : 'Skill'}
                <span className="ml-2 text-xs text-[var(--muted)]">{r.model}</span>
              </span>
              <span className="shrink-0 text-xs text-[var(--muted)]">
                {r.success ? '✓' : '✗'} {formatCost(r.estimatedCost)} · {formatLatency(r.latencyMs)} ·{' '}
                {timeAgo(r.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )
  } else if (section === 'contributions') {
    const contributions = await payload.find({
      collection: 'contribution-logs',
      where: { user: { equals: uid } },
      depth: 0,
      limit: PAGE_SIZE,
      page,
      sort: '-createdAt',
      overrideAccess: true,
    })
    totalPages = contributions.totalPages || 1
    body =
      contributions.docs.length === 0 ? (
        <Empty>暂无记录。</Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(contributions.docs as any[]).map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2">
              <span className="text-[var(--muted)]">{c.description || c.actionType}</span>
              <span className={c.points >= 0 ? 'text-[var(--accent-2)]' : 'text-[var(--danger)]'}>
                {c.points >= 0 ? '+' : ''}
                {c.points}
              </span>
            </li>
          ))}
        </ul>
      )
  } else if (section === 'favorites') {
    const favorites = await payload.find({
      collection: 'favorites',
      where: { user: { equals: uid } },
      depth: 1,
      limit: PAGE_SIZE,
      page,
      sort: '-createdAt',
      overrideAccess: true,
    })
    title = `收藏（${favorites.totalDocs}）`
    totalPages = favorites.totalPages || 1
    body =
      favorites.docs.length === 0 ? (
        <Empty>暂无收藏。</Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(favorites.docs as any[]).map((f) => {
            const s = typeof f.skill === 'object' ? f.skill : null
            return (
              <li key={f.id} className="py-2">
                {s ? (
                  <Link href={`/skills/${s.slug}`} className="hover:text-[var(--accent)]">
                    {s.title}
                  </Link>
                ) : (
                  '—'
                )}
              </li>
            )
          })}
        </ul>
      )
  } else if (section === 'invites') {
    const invites = await payload.find({
      collection: 'invite-codes',
      where: { inviter: { equals: uid } },
      depth: 1,
      limit: PAGE_SIZE,
      page,
      sort: '-createdAt',
      overrideAccess: true,
    })
    totalPages = invites.totalPages || 1
    body =
      invites.docs.length === 0 ? (
        <Empty>暂无邀请码。</Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(invites.docs as any[]).map((i) => (
            <li key={i.id} className="flex items-center justify-between py-2">
              <code className="font-mono">{i.code}</code>
              <span className="text-xs text-[var(--muted)]">
                {i.status === 'unused' ? '未使用' : i.status === 'used' ? '已使用' : i.status}
              </span>
            </li>
          ))}
        </ul>
      )
  }

  return (
    <Section title={title}>
      {body}
      <Pagination page={page} totalPages={totalPages} basePath={`/console/${section}`} params={sp} />
    </Section>
  )
}
