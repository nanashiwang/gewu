import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { formatNumber } from '@/lib/format'
import { trustedCompatibleRunWhere } from '@/lib/trustedRuns'
import { Stat } from '@/components/console/ConsoleUI'

export const dynamic = 'force-dynamic'

export default async function ConsoleOverview() {
  const user = await getCurrentUser()
  const u = user as any
  const payload = await getPayloadClient()
  const uid = u.id as string

  const runners = await payload.find({
    collection: 'runner-clients',
    where: { user: { equals: uid } },
    depth: 0,
    limit: 100,
    overrideAccess: true,
  })
  const runnerIds = runners.docs.map((r: any) => r.id)
  const relaySites = await payload.count({
    collection: 'relay-sites' as any,
    where: { owner: { equals: uid } },
    overrideAccess: true,
  })

  const [installs, runs, successfulRuns, formatValidRuns, trustedRuns, reruns, compatCount] =
    await Promise.all([
      payload.count({
        collection: 'skill-installs',
        where: {
          and: [{ user: { equals: uid } }, { status: { equals: 'installed' } }],
        },
        overrideAccess: true,
      }),
      payload.count({
        collection: 'skill-runs',
        where: { user: { equals: uid } },
        overrideAccess: true,
      }),
      payload.count({
        collection: 'skill-runs',
        where: {
          and: [{ user: { equals: uid } }, { success: { equals: true } }],
        },
        overrideAccess: true,
      }),
      payload.count({
        collection: 'skill-runs',
        where: {
          and: [{ user: { equals: uid } }, { formatValid: { equals: true } }],
        },
        overrideAccess: true,
      }),
      payload.count({
        collection: 'skill-runs',
        where: trustedCompatibleRunWhere(uid),
        overrideAccess: true,
      }),
      payload.count({
        collection: 'skill-runs',
        where: {
          and: [{ user: { equals: uid } }, { rerunOf: { exists: true } }],
        },
        overrideAccess: true,
      }),
      runnerIds.length
        ? payload.count({
            collection: 'compat-reports',
            where: { runner: { in: runnerIds } },
            overrideAccess: true,
          })
        : Promise.resolve({ totalDocs: 0 } as any),
    ])

  const cards = [
    {
      href: '/console/relays',
      label: '我的中转站',
      value: relaySites.totalDocs,
    },
    {
      href: '/console/installs',
      label: '已安装 Skill',
      value: installs.totalDocs,
    },
    {
      href: '/console/runners',
      label: 'Runner 实例',
      value: runners.totalDocs,
    },
    { href: '/console/runs', label: '私人台账', value: runs.totalDocs },
    {
      href: '/console/contributions',
      label: '兼容贡献',
      value: compatCount.totalDocs,
    },
  ]

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{u.username}</h1>
            <p className="text-sm text-[var(--muted)]">{u.email}</p>
          </div>
          <div className="flex gap-6 text-center">
            <Stat label="贡献分" value={formatNumber(u.contributionScore)} />
            <Stat label="可用邀请" value={String(u.inviteCount ?? 0)} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="card p-4 text-center transition-colors hover:border-[var(--accent)]"
          >
            <div className="text-2xl font-bold">{c.value}</div>
            <div className="mt-1 text-xs text-[var(--muted)]">{c.label}</div>
          </Link>
        ))}
      </div>

      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold">私人运行台账</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              这里沉淀你自己的输入、输出、模型、成功状态、格式状态和重跑血缘；用得越多，迁移和复验越方便。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link
              href="/console/runs"
              className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
            >
              查看台账
            </Link>
            <Link
              href="/console/runs?success=false"
              className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
            >
              失败记录
            </Link>
            <Link
              href="/console/runs"
              className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
            >
              重跑记录
            </Link>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="总运行" value={formatNumber(runs.totalDocs)} />
          <Stat label="成功" value={formatNumber(successfulRuns.totalDocs)} />
          <Stat
            label="格式有效"
            value={formatNumber(formatValidRuns.totalDocs)}
          />
          <Stat label="可信兼容" value={formatNumber(trustedRuns.totalDocs)} />
          <Stat label="换模型重跑" value={formatNumber(reruns.totalDocs)} />
        </div>
      </div>
    </div>
  )
}
