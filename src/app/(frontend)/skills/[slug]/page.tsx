import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { aggregateByModel } from '@/lib/compat'
import { getCurrentUser } from '@/lib/auth'
import { SkillStatusTags } from '@/components/Tag'
import { FavoriteButton } from '@/components/FavoriteButton'
import { ReviewForm } from '@/components/ReviewForm'
import { CopyButton } from '@/components/CopyButton'
import { ForkButton } from '@/components/ForkButton'
import { findStoredSkillPackage } from '@/lib/skillPackage'
import { getSkillBenchmarkEvidence } from '@/lib/benchmarkEvidence'
import { canReadSkillEvidence, skillPassportEvidenceWhere } from '@/lib/skillEvidenceAccess'
import { resolveCurrentSkillVersionForPublicEvidence } from '@/lib/skillVersionPublic'
import { publicSkillContract } from '@/lib/skillContractPublic'
import {
  formatCost,
  formatLatency,
  formatNumber,
  formatPercent,
  timeAgo,
} from '@/lib/format'

export const dynamic = 'force-dynamic'

// 每个 Skill 页独立 title/description/OG，供搜索引擎与社交分享抓取（SEO）
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'skills',
      where: { slug: { equals: slug } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const s = res.docs[0] as any
    if (!canReadSkillEvidence(s, null)) return { title: 'Skill · 格物' }
    const desc = String(
      s.description || `${s.title} —— 跨模型兼容评测与本地运行`,
    ).slice(0, 160)
    return {
      title: `${s.title} · 格物`,
      description: desc,
      openGraph: {
        title: s.title as string,
        description: desc,
        type: 'website' as const,
      },
    }
  } catch {
    return { title: 'Skill · 格物' }
  }
}

async function getSkill(slug: string, viewer: any) {
  const payload = await getPayloadClient()
  const res = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    depth: 2,
    limit: 1,
    overrideAccess: true,
  })
  const skill = res.docs[0]
  if (!skill) return null
  if (!canReadSkillEvidence(skill, viewer)) return null

  const version = await resolveCurrentSkillVersionForPublicEvidence(payload as any, skill)
  const reviews = await payload.find({
    collection: 'reviews',
    where: {
      and: [{ skill: { equals: skill.id } }, { status: { equals: 'visible' } }],
    },
    depth: 1,
    limit: 20,
    sort: '-createdAt',
  })
  const versions = await payload.find({
    collection: 'skill-versions',
    where: { skill: { equals: skill.id } },
    sort: '-createdAt',
    limit: 10,
    depth: 0,
    overrideAccess: true,
  })
  const previousVersion = (versions.docs as any[]).find((candidate: any) => (
    String(candidate.id) !== String(version?.id || '') && candidate.status !== 'deprecated'
  ))
  const contract = version ? publicSkillContract(version, { slug: String(skill.slug), previousVersion }) : null
  let checksum: string | null = null
  let signed = false
  let packageAvailable = false
  if (version?.id) {
    const pkg = await findStoredSkillPackage(
      String(skill.id),
      String(version.id),
    ).catch(() => null)
    if (pkg) {
      packageAvailable = true
      checksum = pkg.checksum
    }
    const art = await payload.find({
      collection: 'skill-artifacts',
      where: {
        and: [
          { skillVersion: { equals: version.id } },
          { format: { equals: 'yaml' } },
        ],
      },
      limit: 1,
      overrideAccess: true,
    })
    const a = art.docs[0] as any
    checksum = checksum || (a?.checksum as string) || null
    signed = !!(a?.manifest && String(a.manifest).includes('signature:'))
  }
  const compat = await aggregateByModel(payload, skill.id as string)
  const benchmarkEvidence = await getSkillBenchmarkEvidence(
    payload,
    String(skill.id),
  )
  const passportRes = await payload
    .find({
      collection: 'skill-passports' as any,
      where: skillPassportEvidenceWhere(skill, viewer) as any,
      limit: 1,
      depth: 0,
      sort: '-lastVerifiedAt',
      overrideAccess: true,
    })
    .catch(() => ({ docs: [] as any[] }))
  const passport = passportRes.docs[0] as any
  const evidenceSnapshotRes = passport?.id
    ? await payload
        .find({
          collection: 'evidence-snapshots' as any,
          where: {
            and: [
              { targetType: { equals: 'skill_passport' } },
              { targetId: { equals: String(passport.id) } },
            ],
          },
          limit: 1,
          depth: 0,
          sort: '-createdAt',
          overrideAccess: true,
        })
        .catch(() => ({ docs: [] as any[] }))
    : { docs: [] as any[] }
  const evidenceSnapshot = evidenceSnapshotRes.docs[0] as any
  return {
    skill,
    version,
    reviews: reviews.docs,
    versions: versions.docs,
    contract,
    checksum,
    signed,
    compat,
    packageAvailable,
    passport,
    evidenceSnapshot,
    benchmarkEvidence,
  }
}

export default async function SkillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { slug } = await params
  const sp = await searchParams
  const user = await getCurrentUser()
  const data = await getSkill(slug, user)
  if (!data) notFound()
  const {
    skill,
    version,
    reviews,
    versions,
    checksum,
    signed,
    compat,
    packageAvailable,
    passport,
    evidenceSnapshot,
    benchmarkEvidence,
    contract,
  } = data

  // 收藏态
  let favorited = false
  if (user) {
    const payload = await getPayloadClient()
    const fav = await payload.find({
      collection: 'favorites',
      where: {
        and: [{ user: { equals: user.id } }, { skill: { equals: skill.id } }],
      },
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
  const strategies = (version?.routePolicy?.strategies || {}) as Record<
    string,
    string[]
  >
  const permissions = (version?.permissions || {}) as Record<string, boolean>
  const riskyPermissions = ['network', 'fileRead', 'fileWrite', 'shell'].filter(
    (k) => permissions[k],
  )
  const evidenceCount = compat.reduce(
    (sum: number, m: any) => sum + (m.reports || 0),
    0,
  )
  const verifiedEvidence = compat.reduce(
    (sum: number, m: any) => sum + (m.verified || 0),
    0,
  )
  const passportStatus = passport?.skillClass
    ? String(passport.skillClass).replace('_', ' ')
    : signed
      ? 'Verified'
      : packageAvailable || checksum
        ? 'Imported'
        : 'Draft'
  const compatibilityState =
    passport?.compatibilitySummary?.models?.length > 0
      ? `${passport.compatibilitySummary.models.length} 个模型有持久化兼容证据`
      : compat.length > 0
        ? `${compat.length} 个模型有兼容证据`
        : models?.cloud?.length || models?.local?.length
          ? '仅有作者推荐，等待真实回流'
          : '等待 Model Profile / 兼容证据'
  const signatureStatus =
    passport?.signatureStatus === 'signed'
      ? 'manifest 已签名'
      : passport?.signatureStatus === 'checksum_only'
        ? '有校验和，待签名确认'
        : signed
          ? 'manifest 已签名'
          : checksum
            ? '有校验和，待签名确认'
            : '待生成签名证据'
  const passportEvidenceCount =
    passport?.evidenceSummary?.evidenceCount ?? evidenceCount
  const passportVerifiedCount =
    passport?.evidenceSummary?.verifiedCount ?? verifiedEvidence
  const trustedCompatibleRunCount = Number(
    passport?.reliabilitySummary?.trustedCompatibleRunCount ??
      passport?.evidenceSummary?.trustedCompatibleRunCount ??
      0,
  )
  const passportEvidenceHash = passport?.evidenceHash
    ? String(passport.evidenceHash)
    : ''
  const evidenceVerifyHref = passport?.id
    ? `/verify?targetType=skill_passport&targetId=${encodeURIComponent(String(passport.id))}`
    : ''
  const contractDiff = (contract as any)?.diff || null
  const changedFields = Array.isArray(contractDiff?.changedFields) ? contractDiff.changedFields : []
  const contractDiffFilter = ['breaking', 'compatible'].includes(String(sp.contractDiff || ''))
    ? String(sp.contractDiff)
    : 'all'
  const visibleChangedFields = contractDiffFilter === 'all'
    ? changedFields
    : changedFields.filter((field: any) => field?.severity === contractDiffFilter)
  const breakingFields = Array.isArray(contractDiff?.breakingFields) ? contractDiff.breakingFields : []
  const compatibleFields = Array.isArray(contractDiff?.compatibleFields) ? contractDiff.compatibleFields : []
  const contractDecision = String(contractDiff?.decision || 'baseline')

  return (
    <div className="space-y-6">
      {/* 1. 标题区 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              {cat && (
                <Link
                  href={`/skills?category=${cat.slug}`}
                  className="hover:text-[var(--text)]"
                >
                  {cat.icon} {cat.name}
                </Link>
              )}
              <span>·</span>
              <span>v{version?.version || '—'}</span>
            </div>
            <h1 className="mt-1 text-2xl font-bold">{skill.title}</h1>
            <p className="mt-2 max-w-2xl text-[var(--muted)]">
              {skill.description}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
              <SkillStatusTags skill={skill} />
              {author && <span>作者：{author.username}</span>}
              {typeof skill.forkedFrom === 'object' && skill.forkedFrom && (
                <span>
                  · 🍴 fork 自{' '}
                  <Link
                    href={`/skills/${(skill.forkedFrom as any).slug}`}
                    className="hover:text-[var(--accent)]"
                  >
                    {(skill.forkedFrom as any).title}
                  </Link>
                </span>
              )}
              <span>
                · 更新于 {timeAgo(skill.lastUpdatedAt || skill.createdAt)}
              </span>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto">
            <a
              href={
                packageAvailable
                  ? `/v1/skills/${skill.slug}/package`
                  : `/v1/skills/${skill.slug}/manifest?format=yaml`
              }
              download
              className="btn btn-primary px-6 py-2.5"
            >
              {packageAvailable ? '⬇ 下载 Skill 包' : '⬇ 下载 Skill'}
            </a>
            <Link
              href={`/skills/${skill.slug}/run`}
              className="btn btn-secondary px-6 py-2.5"
            >
              ▶ 在线试用
            </Link>
            <ForkButton slug={skill.slug as string} loggedIn={!!user} />
            <div className="flex gap-2 text-sm">
              <FavoriteButton
                slug={skill.slug as string}
                initial={favorited}
                loggedIn={!!user}
              />
              <a
                href={`/v1/skills/${skill.slug}/manifest?format=json`}
                download
                className="btn btn-secondary flex-1"
              >
                ⬇ JSON
              </a>
            </div>
            <div className="flex items-center gap-2">
              <code
                className="surface block flex-1 truncate px-2.5 py-1.5 text-[10px] text-[var(--muted)]"
                title={checksum || '下载后用本地 Runner / 自有模型运行'}
              >
                {checksum
                  ? `🔒 ${checksum.replace('sha256:', '').slice(0, 18)}…${signed && !packageAvailable ? ' ✓签名' : ''}`
                  : '下载后本地 Runner 运行'}
              </code>
              {checksum && (
                <CopyButton
                  value={checksum}
                  label="复制校验和"
                  title="复制完整 sha256 校验和"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 2. 核心指标 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="可信分"
          value={String(Math.round(skill.skillRank || 0))}
          accent
        />
        <Stat label="成功率" value={formatPercent(skill.successRate)} />
        <Stat label="平均成本" value={formatCost(skill.avgCost)} />
        <Stat label="平均耗时" value={formatLatency(skill.avgLatencyMs)} />
        <Stat
          label="可信兼容"
          value={formatNumber(trustedCompatibleRunCount)}
        />
        <Stat label="收藏" value={formatNumber(skill.favoriteCount)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title="Skill Passport">
            <div className="grid gap-3 sm:grid-cols-2">
              <PassportItem
                label="身份"
                value={`${passportStatus} · v${version?.version || '—'}`}
              />
              <PassportItem label="签名" value={signatureStatus} />
              <PassportItem label="兼容" value={compatibilityState} />
              <PassportItem
                label="证据"
                value={`${passportEvidenceCount} 条回流 · ${passportVerifiedCount} 条 verified · ${formatNumber(trustedCompatibleRunCount)} 次可信兼容`}
              />
              <PassportItem
                label="基准"
                value={
                  benchmarkEvidence.total
                    ? `${benchmarkEvidence.passed}/${benchmarkEvidence.total} 通过 · 均分 ${Math.round(benchmarkEvidence.averageScore * 100)}%`
                    : '等待黄金样例 benchmark'
                }
              />
              <PassportItem
                label="证据快照"
                value={
                  evidenceSnapshot?.id
                    ? `已签名/哈希留痕 · ${String(evidenceSnapshot.payloadHash || '').slice(0, 12)}…`
                    : passportEvidenceHash
                      ? `已生成证据 Hash · ${passportEvidenceHash.slice(0, 12)}…`
                      : '等待证据快照'
                }
              />
              <PassportItem
                label="安全"
                value={
                  riskyPermissions.length
                    ? `需人工审核：${riskyPermissions.join(', ')}`
                    : '低风险 Prompt/结构化 Skill'
                }
              />
              <PassportItem
                label="治理"
                value={
                  skill.visibility === 'enterprise'
                    ? '企业可见，待 Registry 审批'
                    : '公开 Skill，待企业 Registry 接入'
                }
              />
            </div>
            <p className="mt-3 text-xs text-[var(--muted)]">
              Passport 汇总身份、签名、兼容、失败和治理证据；已持久化的 Passport
              会写入证据快照，供第三方复核。
              {evidenceVerifyHref ? (
                <>
                  <a
                    href={evidenceVerifyHref}
                    className="ml-1 text-[var(--accent)] hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    公开验签
                  </a>
                  <a
                    href={`/v1/skills/${skill.slug}/passport`}
                    className="ml-2 text-[var(--accent)] hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    公开 Passport API
                  </a>
                  <a
                    href={`/v1/skills/${skill.slug}/contract`}
                    className="ml-2 text-[var(--accent)] hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Contract
                  </a>
                  <a
                    href={`/v1/skills/${skill.slug}/evidence-package`}
                    className="ml-2 text-[var(--accent)] hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    证据包
                  </a>
                  <a
                    href={`/verify?certificateUrl=${encodeURIComponent(`/v1/skills/${encodeURIComponent(String(skill.slug))}/certificate`)}`}
                    className="ml-2 text-[var(--accent)] hover:underline"
                  >
                    达标证书
                  </a>
                  <Link
                    href="/verify"
                    className="ml-2 text-[var(--accent)] hover:underline"
                  >
                    去验签
                  </Link>
                </>
              ) : null}
            </p>
          </Section>

          <Section title="Contract 变更复核">
            {!contract ? (
              <Empty>等待当前版本 Contract。</Empty>
            ) : (
              <div className="space-y-4 text-sm">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <PassportItem label="当前版本" value={`v${contract.version || version?.version || '—'}`} />
                  <PassportItem label="复核结论" value={contractDecisionLabel(contractDecision)} />
                  <PassportItem label="破坏性字段" value={breakingFields.length ? breakingFields.map(contractFieldLabel).join(' / ') : '无'} />
                  <PassportItem label="兼容字段" value={compatibleFields.length ? compatibleFields.map(contractFieldLabel).join(' / ') : '无'} />
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="font-semibold text-[var(--text)]">Contract Hash</div>
                      <div className="mt-1 font-mono text-[var(--muted)]">
                        {contract.contractHash ? `${String(contract.contractHash).slice(0, 20)}…` : '—'}
                      </div>
                    </div>
                    {contractDiff?.comparedWith ? (
                      <div className="text-[var(--muted)]">
                        对比上一版 v{contractDiff.comparedWith.version || '—'} ·{' '}
                        <span className="font-mono">{String(contractDiff.comparedWith.contractHash || '').slice(0, 12)}…</span>
                      </div>
                    ) : (
                      <div className="text-[var(--muted)]">首版基线，暂无上一版 diff。</div>
                    )}
                  </div>
                </div>
                {changedFields.length ? (
                  <>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {[
                        { key: 'all', label: `全部 ${changedFields.length}` },
                        { key: 'breaking', label: `破坏性 ${breakingFields.length}` },
                        { key: 'compatible', label: `兼容 ${compatibleFields.length}` },
                      ].map((item) => (
                        <Link
                          key={item.key}
                          href={skillContractDiffHref(String(skill.slug), item.key)}
                          className={`rounded-full border px-3 py-1 ${contractDiffFilter === item.key ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'}`}
                        >
                          {item.label}
                        </Link>
                      ))}
                    </div>
                    {visibleChangedFields.length ? (
                      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                        <table className="w-full min-w-[680px] text-xs">
                          <thead>
                            <tr className="border-b border-[var(--border)] bg-[var(--panel-2)] text-left text-[var(--muted)]">
                              <th className="px-3 py-2 font-medium">字段</th>
                              <th className="px-3 py-2 font-medium">影响</th>
                              <th className="px-3 py-2 font-medium">Before Hash</th>
                              <th className="px-3 py-2 font-medium">After Hash</th>
                              <th className="px-3 py-2 font-medium">可见摘要</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleChangedFields.map((field: any) => (
                              <tr key={field.field} className="border-b border-[var(--border)] last:border-0">
                                <td className="px-3 py-2 font-medium">{contractFieldLabel(String(field.field || ''))}</td>
                                <td className={field.severity === 'breaking' ? 'px-3 py-2 text-red-300' : 'px-3 py-2 text-emerald-300'}>
                                  {field.severity === 'breaking' ? '需升级前复核' : '可试跑验证'}
                                </td>
                                <td className="px-3 py-2 font-mono text-[var(--muted)]">{String(field.beforeHash || '').slice(0, 12)}…</td>
                                <td className="px-3 py-2 font-mono text-[var(--muted)]">{String(field.afterHash || '').slice(0, 12)}…</td>
                                <td className="px-3 py-2 text-[var(--muted)]">{contractDiffSummary(field)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty>当前筛选下没有 Contract 字段变化。</Empty>
                    )}
                  </>
                ) : (
                  <Empty>当前版本与上一可用版本无 Contract 字段变化。</Empty>
                )}
                <p className="text-xs text-[var(--muted)]">
                  页面只展示 hash 和脱敏摘要；prompt/template 原文不公开。完整机器可读摘要见{' '}
                  <a href={`/v1/skills/${skill.slug}/contract`} className="text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">
                    Contract API
                  </a>
                  。
                </p>
              </div>
            )}
          </Section>

          {/* 4. 使用说明 */}
          <Section title="输入字段">
            {Object.keys(inputSchema).length === 0 ? (
              <Empty>无输入字段</Empty>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {Object.entries(inputSchema).map(
                  ([key, def]: [string, any]) => (
                    <li
                      key={key}
                      className="flex items-center justify-between py-2 text-sm"
                    >
                      <span>
                        <span className="font-medium">{def.label || key}</span>{' '}
                        <code className="text-xs text-[var(--muted)]">
                          {key}
                        </code>
                        {def.required && (
                          <span className="ml-1 text-[var(--danger)]">*</span>
                        )}
                      </span>
                      <span className="text-xs text-[var(--muted)]">
                        {def.type || 'string'}
                        {def.options ? `（${def.options.length} 选项）` : ''}
                      </span>
                    </li>
                  ),
                )}
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
                  <li
                    key={r.id}
                    className="rounded-lg border border-[var(--border)] p-3"
                  >
                    <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                      <span>
                        {typeof r.user === 'object' ? r.user?.username : '用户'}{' '}
                        ·{' '}
                        {r.type === 'failure_case'
                          ? '失败案例'
                          : r.type === 'compat_report'
                            ? '兼容报告'
                            : '评价'}
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
              {(['cheap', 'balanced', 'quality', 'fast'] as const).map(
                (mode) => {
                  const list = strategies[mode]
                  if (!list || list.length === 0) return null
                  const labels: Record<string, string> = {
                    cheap: '成本优先',
                    balanced: '均衡',
                    quality: '高质量',
                    fast: '快速',
                  }
                  return (
                    <div
                      key={mode}
                      className="flex items-start justify-between gap-2"
                    >
                      <span className="text-[var(--muted)]">
                        {labels[mode]}
                      </span>
                      <span className="text-right text-xs">
                        {list.join(' → ')}
                      </span>
                    </div>
                  )
                },
              )}
              {models?.local?.length > 0 && (
                <div className="flex items-start justify-between gap-2 border-t border-[var(--border)] pt-2">
                  <span className="text-[var(--muted)]">本地模型</span>
                  <span className="text-right text-xs">
                    {models.local.join(', ')}
                  </span>
                </div>
              )}
            </div>
          </Section>

          <Section title="黄金样例基准">
            {benchmarkEvidence.total === 0 ? (
              <Empty>
                暂无黄金样例打分。管理员可在 CompatTestCase 配置
                requiredOutputPaths / expectedTextIncludes 后运行 benchmark。
              </Empty>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2">
                    <div className="text-base font-semibold text-[var(--accent)]">
                      {Math.round(benchmarkEvidence.averageScore * 100)}%
                    </div>
                    <div className="text-[var(--muted)]">平均分</div>
                  </div>
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2">
                    <div className="text-base font-semibold">
                      {benchmarkEvidence.passed}/{benchmarkEvidence.total}
                    </div>
                    <div className="text-[var(--muted)]">通过</div>
                  </div>
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2">
                    <div className="text-base font-semibold">
                      {benchmarkEvidence.cases.length}
                    </div>
                    <div className="text-[var(--muted)]">样例</div>
                  </div>
                </div>
                <ul className="space-y-2">
                  {benchmarkEvidence.cases.slice(0, 5).map((item: any) => (
                    <li
                      key={item.caseId}
                      className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{item.title}</span>
                        <span
                          className={
                            item.passed === item.total
                              ? 'text-[var(--accent-2)]'
                              : 'text-amber-200'
                          }
                        >
                          {item.passed}/{item.total} ·{' '}
                          {Math.round(item.averageScore * 100)}%
                        </span>
                      </div>
                      <div className="mt-1 truncate text-[var(--muted)]">
                        模型：{item.models.join(', ') || '—'}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          {/* 6. 本地模型兼容报告 */}
          <Section
            title={`本地模型兼容报告${(skill as any).localScore ? ` · 兼容分 ${(skill as any).localScore}` : ''}`}
          >
            {compat.length === 0 ? (
              <Empty>
                暂无兼容报告。用{' '}
                <code className="surface px-1 text-[11px]">
                  gewu run --report
                </code>{' '}
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
                    <th className="py-1.5 text-right font-medium">有效样本</th>
                    <th className="py-1.5 text-right font-medium">行动</th>
                  </tr>
                </thead>
                <tbody>
                  {compat.map((m: any) => {
                    const modelParams = new URLSearchParams({
                      modelName: String(m.modelName),
                      ...(m.modelVersion ? { modelVersion: String(m.modelVersion) } : {}),
                    })
                    const modelSkillParams = new URLSearchParams({
                      modelName: String(m.modelName),
                      skillId: String(skill.id),
                      ...(m.modelVersion ? { modelVersion: String(m.modelVersion) } : {}),
                    })
                    return (
                    <tr
                      key={
                        m.modelProfile ||
                        `${m.modelName}:${m.modelVersion || ''}`
                      }
                      className="border-b border-[var(--border)] last:border-0"
                    >
                      <td className="py-1.5 font-mono">
                        {m.modelName}
                        {m.modelVersion ? (
                          <span className="ml-1 text-[var(--muted)]">
                            /{m.modelVersion}
                          </span>
                        ) : null}
                      </td>
                      {m.lowSample ? (
                        <td
                          className="py-1.5 text-right text-[var(--muted)]"
                          colSpan={3}
                        >
                          战绩积累中 · 已 {m.reports} 次
                        </td>
                      ) : (
                        <>
                          <td className="py-1.5 text-right">
                            {formatPercent(m.successRate)}
                          </td>
                          <td className="py-1.5 text-right">
                            {formatPercent(m.formatRate)}
                          </td>
                          <td className="py-1.5 text-right">
                            {formatLatency(m.avgLatencyMs)}
                          </td>
                        </>
                      )}
                      <td className="py-1.5 text-right text-[var(--muted)]">
                        {m.reports}
                        {m.verified ? (
                          <span className="ml-1 text-[var(--accent-2)]">
                            ✓{m.verified}
                          </span>
                        ) : null}
                      </td>
                      <td
                        className="py-1.5 text-right text-[var(--muted)]"
                        title={
                          m.sourceSummary
                            ?.map(
                              (s: any) => `${s.source}×${s.weight}:${s.count}`,
                            )
                            .join(' / ') || ''
                        }
                      >
                        {m.effectiveSamples ?? '—'}
                      </td>
                      <td className="py-1.5 text-right">
                        <Link
                          href={`/models?${modelParams.toString()}`}
                          className="text-[var(--accent)] hover:underline"
                        >
                          画像
                        </Link>
                        <Link
                          href={`/failures?${modelSkillParams.toString()}`}
                          className="ml-2 text-[var(--accent)] hover:underline"
                        >
                          失败
                        </Link>
                        <a
                          href={`/v1/adapters?${modelSkillParams.toString()}`}
                          className="ml-2 text-[var(--accent)] hover:underline"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Adapter
                        </a>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Section>

          {/* 7. 版本历史 */}
          <Section title="版本历史">
            <ul className="space-y-2 text-sm">
              {versions.map((v: any) => (
                <li
                  key={v.id}
                  className="flex items-start justify-between gap-2"
                >
                  <span className="font-medium">v{v.version}</span>
                  <span className="text-right text-xs text-[var(--muted)]">
                    {contractStatusLabel(String(v.contractStatus || 'initial'))}
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

function contractDecisionLabel(decision: string) {
  const labels: Record<string, string> = {
    baseline: '首版基线',
    no_change: '无变化',
    safe_to_trial: '可试跑验证',
    review_before_upgrade: '升级前复核',
  }
  return labels[decision] || decision
}

function skillContractDiffHref(slug: string, filter: string) {
  return filter === 'all'
    ? `/skills/${encodeURIComponent(slug)}`
    : `/skills/${encodeURIComponent(slug)}?contractDiff=${encodeURIComponent(filter)}`
}

function contractStatusLabel(status: string) {
  const labels: Record<string, string> = {
    initial: '初始 Contract',
    compatible_change: '兼容变更',
    breaking_change: '破坏性变更',
  }
  return labels[status] || status
}

function contractFieldLabel(field: string) {
  const labels: Record<string, string> = {
    systemPrompt: 'System Prompt',
    promptTemplate: 'User 模板',
    inputSchema: '输入 schema',
    outputSchema: '输出 schema',
    recommendedModels: '推荐模型',
    routePolicy: '路由策略',
    permissions: '权限',
    minRunnerVersion: '最低 Runner',
  }
  return labels[field] || field
}

function contractDiffSummary(field: any) {
  if (['systemPrompt', 'promptTemplate'].includes(String(field?.field || ''))) return '仅公开 hash，不暴露 prompt 正文'
  const before = field?.before == null ? '—' : JSON.stringify(field.before)
  const after = field?.after == null ? '—' : JSON.stringify(field.after)
  const text = `${before} → ${after}`
  return text.length > 96 ? `${text.slice(0, 96)}…` : text
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-center">
      <div
        className={`text-lg font-bold ${accent ? 'text-[var(--accent)]' : ''}`}
      >
        {value}
      </div>
      <div className="text-xs text-[var(--muted)]">{label}</div>
    </div>
  )
}

function PassportItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
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
