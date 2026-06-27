import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { aggregateByModel } from '@/lib/compat'
import { getCurrentUser } from '@/lib/auth'
import { SkillStatusTags } from '@/components/Tag'
import { FavoriteButton } from '@/components/FavoriteButton'
import { ReviewForm } from '@/components/ReviewForm'
import {
  formatCost,
  formatLatency,
  formatNumber,
  formatPercent,
  timeAgo,
} from '@/lib/format'

export const dynamic = 'force-dynamic'

async function getSkill(slug: string) {
  const payload = await getPayloadClient()
  const res = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    depth: 2,
    limit: 1,
  })
  const skill = res.docs[0]
  if (!skill || skill.status !== 'published') return null

  let version: any = skill.currentVersion
  if (version && typeof version === 'string') {
    version = (
      await payload.find({
        collection: 'skill-versions',
        where: { skill: { equals: skill.id } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
  }
  const reviews = await payload.find({
    collection: 'reviews',
    where: { and: [{ skill: { equals: skill.id } }, { status: { equals: 'visible' } }] },
    depth: 1,
    limit: 20,
    sort: '-createdAt',
  })
  const versions = await payload.find({
    collection: 'skill-versions',
    where: { skill: { equals: skill.id } },
    sort: '-createdAt',
    limit: 10,
  })
  let checksum: string | null = null
  let signed = false
  if (version?.id) {
    const art = await payload.find({
      collection: 'skill-artifacts',
      where: { and: [{ skillVersion: { equals: version.id } }, { format: { equals: 'yaml' } }] },
      limit: 1,
    })
    const a = art.docs[0] as any
    checksum = (a?.checksum as string) || null
    signed = !!(a?.manifest && String(a.manifest).includes('signature:'))
  }
  const compat = await aggregateByModel(payload, skill.id as string)
  return { skill, version, reviews: reviews.docs, versions: versions.docs, checksum, signed, compat }
}

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const data = await getSkill(slug)
  if (!data) notFound()
  const { skill, version, reviews, versions, checksum, signed, compat } = data

  // 当前用户与收藏态
  const user = await getCurrentUser()
  let favorited = false
  if (user) {
    const payload = await getPayloadClient()
    const fav = await payload.find({
      collection: 'favorites',
      where: { and: [{ user: { equals: user.id } }, { skill: { equals: skill.id } }] },
      limit: 1,
      overrideAccess: true,
    })
    favorited = fav.totalDocs > 0
  }

  const cat = typeof skill.category === 'object' ? skill.category : null
  const author = typeof skill.author === 'object' ? skill.author : null
  const inputSchema = (version?.inputSchema || {}) as Record<string, any>
  const outputSchema = (version?.outputSchema || {}) as Record<string, any>
  const models = (version?.recommendedModels || {}) as any
  const strategies = (version?.routePolicy?.strategies || {}) as Record<string, string[]>

  return (
    <div className="space-y-6">
      {/* 1. 标题区 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              {cat && (
                <Link href={`/skills?category=${cat.slug}`} className="hover:text-[var(--text)]">
                  {cat.icon} {cat.name}
                </Link>
              )}
              <span>·</span>
              <span>v{version?.version || '—'}</span>
            </div>
            <h1 className="mt-1 text-2xl font-bold">{skill.title}</h1>
            <p className="mt-2 max-w-2xl text-[var(--muted)]">{skill.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
              <SkillStatusTags skill={skill} />
              {author && <span>作者：{author.username}</span>}
              <span>· 更新于 {timeAgo(skill.lastUpdatedAt || skill.createdAt)}</span>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto">
            <a
              href={`/v1/skills/${skill.slug}/manifest?format=yaml`}
              download
              className="btn btn-primary px-6 py-2.5"
            >
              ⬇ 下载 Skill
            </a>
            <Link href={`/skills/${skill.slug}/run`} className="btn btn-secondary px-6 py-2.5">
              ▶ 在线试用
            </Link>
            <div className="flex gap-2 text-sm">
              <FavoriteButton slug={skill.slug as string} initial={favorited} loggedIn={!!user} />
              <a
                href={`/v1/skills/${skill.slug}/manifest?format=json`}
                download
                className="btn btn-secondary flex-1"
              >
                ⬇ JSON
              </a>
            </div>
            <code
              className="surface block px-2.5 py-1.5 text-[10px] text-[var(--muted)]"
              title={checksum || '下载后用本地 Runner / 自有模型运行'}
            >
              {checksum ? `🔒 ${checksum.replace('sha256:', '').slice(0, 18)}…${signed ? ' ✓签名' : ''}` : '下载后本地 Runner 运行'}
            </code>
          </div>
        </div>
      </div>

      {/* 2. 核心指标 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="SkillRank" value={String(Math.round(skill.skillRank || 0))} accent />
        <Stat label="成功率" value={formatPercent(skill.successRate)} />
        <Stat label="平均成本" value={formatCost(skill.avgCost)} />
        <Stat label="平均耗时" value={formatLatency(skill.avgLatencyMs)} />
        <Stat label="调用量" value={formatNumber(skill.runCount)} />
        <Stat label="收藏" value={formatNumber(skill.favoriteCount)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* 4. 使用说明 */}
          <Section title="输入字段">
            {Object.keys(inputSchema).length === 0 ? (
              <Empty>无输入字段</Empty>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {Object.entries(inputSchema).map(([key, def]: [string, any]) => (
                  <li key={key} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      <span className="font-medium">{def.label || key}</span>{' '}
                      <code className="text-xs text-[var(--muted)]">{key}</code>
                      {def.required && <span className="ml-1 text-[var(--danger)]">*</span>}
                    </span>
                    <span className="text-xs text-[var(--muted)]">
                      {def.type || 'string'}
                      {def.options ? `（${def.options.length} 选项）` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="输出格式">
            {Object.keys(outputSchema).length === 0 ? (
              <Empty>自由文本输出</Empty>
            ) : (
              <pre className="overflow-x-auto rounded-lg bg-[var(--panel-2)] p-3 text-xs text-[var(--muted)]">
                {JSON.stringify(outputSchema, null, 2)}
              </pre>
            )}
          </Section>

          {/* 8. 评论反馈 */}
          <Section title={`评论反馈（${reviews.length}）`}>
            <ReviewForm skillId={skill.id} loggedIn={!!user} />
            {reviews.length === 0 ? (
              <Empty>还没有评论。运行后欢迎留下评价与失败案例。</Empty>
            ) : (
              <ul className="space-y-3">
                {reviews.map((r: any) => (
                  <li key={r.id} className="rounded-lg border border-[var(--border)] p-3">
                    <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                      <span>
                        {typeof r.user === 'object' ? r.user?.username : '用户'} ·{' '}
                        {r.type === 'failure_case' ? '失败案例' : r.type === 'compat_report' ? '兼容报告' : '评价'}
                      </span>
                      <span>{'★'.repeat(r.rating || 0)}</span>
                    </div>
                    <p className="mt-1 text-sm">{r.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          {/* 5. 模型推荐 */}
          <Section title="模型推荐">
            <div className="space-y-2 text-sm">
              {(['cheap', 'balanced', 'quality', 'fast'] as const).map((mode) => {
                const list = strategies[mode]
                if (!list || list.length === 0) return null
                const labels: Record<string, string> = {
                  cheap: '省钱',
                  balanced: '均衡',
                  quality: '高质量',
                  fast: '快速',
                }
                return (
                  <div key={mode} className="flex items-start justify-between gap-2">
                    <span className="text-[var(--muted)]">{labels[mode]}</span>
                    <span className="text-right text-xs">{list.join(' → ')}</span>
                  </div>
                )
              })}
              {models?.local?.length > 0 && (
                <div className="flex items-start justify-between gap-2 border-t border-[var(--border)] pt-2">
                  <span className="text-[var(--muted)]">本地模型</span>
                  <span className="text-right text-xs">{models.local.join(', ')}</span>
                </div>
              )}
            </div>
          </Section>

          {/* 6. 本地模型兼容报告 */}
          <Section
            title={`本地模型兼容报告${(skill as any).localScore ? ` · LocalScore ${(skill as any).localScore}` : ''}`}
          >
            {compat.length === 0 ? (
              <Empty>
                暂无兼容报告。用 <code className="surface px-1 text-[11px]">hengshu run --report</code>{' '}
                贡献你本地模型的兼容数据（不含输入/输出）。
              </Empty>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                    <th className="py-1.5 font-medium">模型</th>
                    <th className="py-1.5 text-right font-medium">成功率</th>
                    <th className="py-1.5 text-right font-medium">JSON率</th>
                    <th className="py-1.5 text-right font-medium">耗时</th>
                    <th className="py-1.5 text-right font-medium">报告</th>
                  </tr>
                </thead>
                <tbody>
                  {compat.map((m: any) => (
                    <tr key={m.modelName} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-1.5 font-mono">{m.modelName}</td>
                      <td className="py-1.5 text-right">{formatPercent(m.successRate)}</td>
                      <td className="py-1.5 text-right">{formatPercent(m.formatRate)}</td>
                      <td className="py-1.5 text-right">{formatLatency(m.avgLatencyMs)}</td>
                      <td className="py-1.5 text-right text-[var(--muted)]">
                        {m.reports}
                        {m.verified ? <span className="ml-1 text-[var(--accent-2)]">✓{m.verified}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* 7. 版本历史 */}
          <Section title="版本历史">
            <ul className="space-y-2 text-sm">
              {versions.map((v: any) => (
                <li key={v.id} className="flex items-start justify-between gap-2">
                  <span className="font-medium">v{v.version}</span>
                  <span className="text-right text-xs text-[var(--muted)]">
                    {v.changelog || '—'}
                    <br />
                    {timeAgo(v.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-center">
      <div className={`text-lg font-bold ${accent ? 'text-[var(--accent)]' : ''}`}>{value}</div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-[var(--muted)]">{children}</div>
}
