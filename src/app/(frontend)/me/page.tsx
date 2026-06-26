import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { formatCost, formatLatency, formatNumber, timeAgo } from '@/lib/format'

export const dynamic = 'force-dynamic'

const ROLE_LABELS: Record<string, string> = {
  user: '普通用户',
  creator: '创作者',
  certified_creator: '认证创作者',
  reviewer: '审核员',
  admin: '管理员',
  enterprise_admin: '企业管理员',
}

export default async function MePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const payload = await getPayloadClient()
  const uid = user.id as string

  const runners = await payload.find({
    collection: 'runner-clients',
    where: { user: { equals: uid } },
    limit: 50,
    sort: '-lastSeenAt',
    overrideAccess: true,
  })
  const runnerIds = runners.docs.map((r: any) => r.id)

  const [runs, favorites, contributions, invites, installs, compatCount] = await Promise.all([
    payload.find({ collection: 'skill-runs', where: { user: { equals: uid } }, depth: 1, limit: 8, sort: '-createdAt', overrideAccess: true }),
    payload.find({ collection: 'favorites', where: { user: { equals: uid } }, depth: 1, limit: 20, sort: '-createdAt', overrideAccess: true }),
    payload.find({ collection: 'contribution-logs', where: { user: { equals: uid } }, depth: 0, limit: 12, sort: '-createdAt', overrideAccess: true }),
    payload.find({ collection: 'invite-codes', where: { inviter: { equals: uid } }, depth: 1, limit: 20, sort: '-createdAt', overrideAccess: true }),
    payload.find({ collection: 'skill-installs', where: { and: [{ user: { equals: uid } }, { status: { equals: 'installed' } }] }, depth: 1, limit: 50, sort: '-lastUsedAt', overrideAccess: true }),
    runnerIds.length
      ? payload.count({ collection: 'compat-reports', where: { runner: { in: runnerIds } }, overrideAccess: true })
      : Promise.resolve({ totalDocs: 0 } as any),
  ])

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

  const u = user as any

  return (
    <div className="space-y-6">
      {/* 资料卡 */}
      <div className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{u.username}</h1>
            <p className="text-sm text-[var(--muted)]">
              {ROLE_LABELS[u.role] || u.role} · Lv.{u.level} · {u.email}
            </p>
          </div>
          <div className="flex gap-6 text-center">
            <Stat label="术值" value={formatNumber(u.contributionScore)} />
            <Stat label="已安装" value={String(installs.totalDocs)} />
            <Stat label="兼容贡献" value={String(compatCount.totalDocs)} />
            <Stat label="可用邀请" value={String(u.inviteCount ?? 0)} />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 已安装 Skill */}
        <Section title={`已安装 Skill（${installs.totalDocs}）`}>
          {installs.docs.length === 0 ? (
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
          )}
        </Section>

        {/* Runner 实例 */}
        <Section title={`Runner 实例（${runners.totalDocs}）`}>
          {runners.docs.length === 0 ? (
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
          )}
        </Section>

        {/* 运行记录 */}
        <Section title={`运行记录（${runs.totalDocs}）`}>
          {runs.docs.length === 0 ? (
            <Empty>
              还没有运行记录。去 <Link href="/skills" className="text-[var(--accent)]">Skill 市场</Link> 跑一个吧。
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
                    {r.success ? '✓' : '✗'} {formatCost(r.estimatedCost)} · {formatLatency(r.latencyMs)} · {timeAgo(r.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* 贡献流水 */}
        <Section title="术值流水">
          {contributions.docs.length === 0 ? (
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
          )}
        </Section>

        {/* 收藏 */}
        <Section title={`收藏（${favorites.totalDocs}）`}>
          {favorites.docs.length === 0 ? (
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
          )}
        </Section>

        {/* 邀请码 */}
        <Section title="我的邀请码">
          {invites.docs.length === 0 ? (
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
          )}
        </Section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-bold text-[var(--accent)]">{value}</div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
    </div>
  )
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-[var(--muted)]">{children}</div>
}
