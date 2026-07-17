import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { formatCost, formatLatency, timeAgo } from '@/lib/format'
import { Section, Empty } from '@/components/console/ConsoleUI'
import { Pagination } from '@/components/Pagination'
import { CopyButton } from '@/components/CopyButton'
import { BulkRerunPanel } from '@/components/console/BulkRerunPanel'
import { RerunButton } from '@/components/console/RerunButton'
import { MarkNotificationsRead } from '@/components/console/MarkNotificationsRead'
import { RevokeRunnerButton } from '@/components/console/RevokeRunnerButton'
import { buildRunLedgerWhere } from '@/lib/runLedgerPublic'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 30

function searchParamsToUrl(sp: Record<string, string | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    if (value) params.set(key, value)
  }
  return params
}

function runLedgerFiltersActive(sp: Record<string, string | undefined>) {
  return Boolean(
    sp.skillId ||
    sp.skill ||
    sp.model ||
    sp.modelVersion ||
    sp.routeMode ||
    sp.success ||
    sp.formatValid ||
    sp.trustedCompatible ||
    sp.rerunOf,
  )
}

function runLedgerExportHref(
  sp: Record<string, string | undefined>,
  includeIO = false,
) {
  const params = new URLSearchParams()
  for (const key of [
    'skillId',
    'skill',
    'model',
    'modelVersion',
    'routeMode',
    'success',
    'formatValid',
    'trustedCompatible',
    'rerunOf',
  ]) {
    const value = sp[key]
    if (value) params.set(key, value)
  }
  if (includeIO) params.set('includeIO', '1')
  const qs = params.toString()
  return qs ? `/v1/runs?${qs}` : '/v1/runs'
}

function runCompare(current: any, parent: any) {
  if (!parent || typeof parent !== 'object') return null
  const costDelta =
    Number(current.estimatedCost || 0) - Number(parent.estimatedCost || 0)
  const latencyDelta =
    Number(current.latencyMs || 0) - Number(parent.latencyMs || 0)
  return { costDelta, latencyDelta, parent }
}

const TITLES: Record<string, string> = {
  installs: '已安装 Skill',
  runners: 'Runner 实例',
  runs: '私人台账',
  contributions: '贡献流水',
  favorites: '收藏',
  invites: '邀请码',
  notifications: '通知',
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
      where: {
        and: [{ user: { equals: uid } }, { status: { equals: 'installed' } }],
      },
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
      const skillId =
        typeof inst.skill === 'object' ? inst.skill?.id : inst.skill
      const art = await payload.find({
        collection: 'skill-artifacts',
        where: {
          and: [{ skill: { equals: skillId } }, { format: { equals: 'yaml' } }],
        },
        sort: '-createdAt',
        limit: 1,
        overrideAccess: true,
      })
      const current = (art.docs[0] as any)?.checksum
      if (
        current &&
        inst.installedChecksum &&
        current !== inst.installedChecksum
      )
        outdated.add(inst.id)
    }

    body =
      installs.docs.length === 0 ? (
        <Empty>
          还没装。用{' '}
          <code className="surface px-1 text-[11px]">
            gewu install &lt;slug&gt;
          </code>{' '}
          安装到本地。
        </Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(installs.docs as any[]).map((inst) => {
            const s = typeof inst.skill === 'object' ? inst.skill : null
            return (
              <li
                key={inst.id}
                className="flex items-center justify-between py-2"
              >
                <span className="min-w-0 truncate">
                  {s ? (
                    <Link
                      href={`/skills/${s.slug}`}
                      className="hover:text-[var(--accent)]"
                    >
                      {s.title}
                    </Link>
                  ) : (
                    'Skill'
                  )}
                  <span className="ml-2 text-xs text-[var(--muted)]">
                    v{inst.installedVersion}
                  </span>
                </span>
                {outdated.has(inst.id) ? (
                  <span className="shrink-0 rounded border border-[var(--warn)] px-1.5 py-0.5 text-[11px] text-[var(--warn)]">
                    待更新
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    {timeAgo(inst.lastUsedAt)}
                  </span>
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
          还没绑定设备。终端{' '}
          <code className="surface px-1 text-[11px]">gewu login</code> 登录。
        </Empty>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(runners.docs as any[]).map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs">
                  {String(r.runnerId).slice(0, 13)}…
                </span>
                <span className="text-xs text-[var(--muted)]">
                  {r.label ? `${r.label} · ` : ''}
                  {r.os}/{r.arch} · {r.trustedLevel} · {timeAgo(r.lastSeenAt)}
                </span>
              </span>
              <RevokeRunnerButton
                runnerId={r.id}
                label={r.label || String(r.runnerId).slice(0, 8)}
              />
            </li>
          ))}
        </ul>
      )
  } else if (section === 'runs') {
    const runWhere = buildRunLedgerWhere(uid, searchParamsToUrl(sp))
    const runFiltersActive = runLedgerFiltersActive(sp)
    const runs = await payload.find({
      collection: 'skill-runs',
      where: runWhere,
      depth: 2, // 需 depth2 populate skill.currentVersion.recommendedModels 供换模型下拉
      limit: PAGE_SIZE,
      page,
      sort: '-createdAt',
      overrideAccess: true,
    })
    title = `私人台账（${runs.totalDocs}）`
    totalPages = runs.totalPages || 1
    // 本月成本优化回执（私人台账留存钩子）：本月运行的 savedAmount 之和
    const mStart = new Date()
    mStart.setDate(1)
    mStart.setHours(0, 0, 0, 0)
    const savedAgg = await payload.find({
      collection: 'skill-runs',
      where: {
        and: [
          { user: { equals: uid } },
          { createdAt: { greater_than_equal: mStart.toISOString() } },
        ],
      },
      limit: 2000,
      depth: 0,
      overrideAccess: true,
    })
    const monthSaved = (savedAgg.docs as any[]).reduce(
      (s, r) => s + (r.savedAmount || 0),
      0,
    )
    const visibleRunIds = (runs.docs as any[]).map((r) => String(r.id))
    const visibleRecommendedModels = [
      ...new Set(
        (runs.docs as any[]).flatMap((r) =>
          typeof r.skill === 'object' &&
          r.skill?.currentVersion &&
          typeof r.skill.currentVersion === 'object' &&
          Array.isArray(r.skill.currentVersion?.recommendedModels?.cloud)
            ? r.skill.currentVersion.recommendedModels.cloud
            : [],
        ),
      ),
    ].map((m) => String(m))
    body = (
      <div className="space-y-3">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3 text-xs text-[var(--muted)]">
          <div className="font-medium text-[var(--text)]">私人运行台账导出</div>
          <div className="mt-1">
            默认只导出模型、成本、延迟、成功状态、重跑血缘等账本指标；如需迁移完整个人数据，可导出输入/输出原文。下方筛选会同步作用于列表和导出。
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2">
              <div className="font-medium text-[var(--text)]">1. 留住历史输入</div>
              <div className="mt-1">每次试跑都沉淀为你的私人账本，不再只是看完即走。</div>
            </div>
            <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2">
              <div className="font-medium text-[var(--text)]">2. 同输入换模型</div>
              <div className="mt-1">一键重跑保留 Skill 版本和输入，只替换模型/版本。</div>
            </div>
            <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2">
              <div className="font-medium text-[var(--text)]">3. 对比省钱回执</div>
              <div className="mt-1">重跑血缘会展示成本、延迟和成功结果变化。</div>
            </div>
            <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2">
              <div className="font-medium text-[var(--text)]">4. 失败进知识库</div>
              <div className="mt-1">失败运行可直达失败库，继续生成 Adapter 修复闭环。</div>
            </div>
          </div>
          <form
            action="/console/runs"
            className="mt-3 grid gap-2 md:grid-cols-3 lg:grid-cols-6"
          >
            <input type="hidden" name="page" value="1" />
            <input
              name="skillId"
              defaultValue={sp.skillId || sp.skill || ''}
              placeholder="Skill ID"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            />
            <input
              name="model"
              defaultValue={sp.model || ''}
              placeholder="模型"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            />
            <input
              name="modelVersion"
              defaultValue={sp.modelVersion || ''}
              placeholder="模型版本"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            />
            <input
              name="routeMode"
              defaultValue={sp.routeMode || ''}
              placeholder="路由"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            />
            <select
              name="success"
              defaultValue={sp.success || ''}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            >
              <option value="">成功状态</option>
              <option value="true">成功</option>
              <option value="false">失败</option>
            </select>
            <select
              name="formatValid"
              defaultValue={sp.formatValid || ''}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            >
              <option value="">格式状态</option>
              <option value="true">格式有效</option>
              <option value="false">格式异常</option>
            </select>
            <select
              name="trustedCompatible"
              defaultValue={sp.trustedCompatible || ''}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            >
              <option value="">可信兼容</option>
              <option value="true">只看可信兼容</option>
            </select>
            <input
              name="rerunOf"
              defaultValue={sp.rerunOf || ''}
              placeholder="重跑源 ID"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            />
            <div className="flex flex-wrap gap-2 md:col-span-3 lg:col-span-6">
              <button
                type="submit"
                className="rounded border border-[var(--border)] px-2 py-1 text-[var(--text)] hover:border-[var(--accent)]"
              >
                筛选台账
              </button>
              {runFiltersActive ? (
                <a
                  href="/console/runs"
                  className="rounded border border-[var(--border)] px-2 py-1 text-[var(--muted)] hover:text-[var(--text)]"
                >
                  清空筛选
                </a>
              ) : null}
              <a
                href={runLedgerExportHref(sp)}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-[var(--border)] px-2 py-1 text-[var(--text)] hover:border-[var(--accent)]"
              >
                导出账本指标 JSON
              </a>
              <a
                href={runLedgerExportHref(sp, true)}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-amber-500/40 px-2 py-1 text-amber-200 hover:border-amber-300"
              >
                导出含输入/输出 JSON
              </a>
            </div>
          </form>
        </div>
        {monthSaved > 0 && (
          <div className="rounded-lg border border-[var(--accent-2)] bg-[var(--panel-2)] px-4 py-3 text-sm">
            本月模型适配为你降低成本估算{' '}
            <b className="text-[var(--accent-2)]">{formatCost(monthSaved)}</b>
            <span className="ml-1 text-xs text-[var(--muted)]">
              （相比默认模型的成本估算，作为台账参考）
            </span>
          </div>
        )}
        {runs.docs.length > 0 && (
          <BulkRerunPanel
            runIds={visibleRunIds}
            recommendedModels={visibleRecommendedModels}
          />
        )}
        {runs.docs.length === 0 ? (
          <Empty>
            {runFiltersActive ? (
              <>
                没有匹配的台账记录。请调整条件，或{' '}
                <a href="/console/runs" className="text-[var(--accent)]">
                  清空筛选
                </a>
                。
              </>
            ) : (
              <>
                还没有台账记录。去{' '}
                <Link href="/skills" className="text-[var(--accent)]">
                  Skill 市场
                </Link>{' '}
                跑一个吧。
              </>
            )}
          </Empty>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {(runs.docs as any[]).map((r) => {
              const compare = runCompare(r, r.rerunOf)
              const skillId =
                typeof r.skill === 'object' ? r.skill?.id : r.skill
              const failureHref = `/failures?${new URLSearchParams({
                ...(skillId ? { skillId: String(skillId) } : {}),
                ...(r.model ? { modelName: String(r.model) } : {}),
                ...(r.modelVersion ? { modelVersion: String(r.modelVersion) } : {}),
                ...(r.errorCode ? { errorType: String(r.errorCode) } : {}),
              }).toString()}`
              const modelHref = r.model
                ? `/models?${new URLSearchParams({
                    modelName: String(r.model),
                    ...(r.modelVersion ? { modelVersion: String(r.modelVersion) } : {}),
                  }).toString()}`
                : '/models'
              return (
                <li key={r.id} className="py-2">
                  <details>
                    <summary className="flex cursor-pointer items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {typeof r.skill === 'object' ? r.skill?.title : 'Skill'}
                        <span className="ml-2 text-xs text-[var(--muted)]">
                          {r.model}
                          {r.modelVersion ? ` · ${r.modelVersion}` : ''}
                        </span>
                        {r.savedAmount > 0 && (
                          <span className="ml-2 text-xs text-[var(--accent-2)]">
                            降本{formatCost(r.savedAmount)}
                          </span>
                        )}
                        {r.rerunOf && (
                          <span className="ml-2 text-xs text-[var(--accent)]">
                            重跑自 {r.rerunFromModel || '历史模型'}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--muted)]">
                        {r.success ? '✓' : '✗'} {formatCost(r.estimatedCost)} ·{' '}
                        {formatLatency(r.latencyMs)} · {timeAgo(r.createdAt)}
                      </span>
                    </summary>
                    <div className="mt-2 space-y-2 rounded-lg bg-[var(--panel-2)] p-3 text-xs">
                      <div>
                        <div className="mb-1 text-[var(--muted)]">输入</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
                          {JSON.stringify(r.inputJson ?? {}, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-1 text-[var(--muted)]">输出</div>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">
                          {String(r.outputText || '（无输出）').slice(0, 4000)}
                        </pre>
                      </div>
                      <div className="flex flex-wrap gap-3 text-[var(--muted)]">
                        <span>
                          模型 {r.model}
                          {r.modelVersion ? ` · ${r.modelVersion}` : ''}
                        </span>
                        <span>路由 {r.routeMode || '—'}</span>
                        <span>成本 {formatCost(r.estimatedCost)}</span>
                        {r.chargedCredits > 0 && (
                          <span>实扣 {r.chargedCredits} credit</span>
                        )}
                        {r.savedAmount > 0 && (
                          <span className="text-[var(--accent-2)]">
                            降本 {formatCost(r.savedAmount)}
                          </span>
                        )}
                        {r.errorCode && (
                          <span className="text-[var(--danger)]">
                            错误 {r.errorCode}
                          </span>
                        )}
                        <Link
                          href={modelHref}
                          className="text-[var(--accent)] hover:underline"
                        >
                          模型画像
                        </Link>
                        {!r.success && (
                          <Link
                            href={failureHref}
                            className="text-[var(--accent)] hover:underline"
                          >
                            查失败库
                          </Link>
                        )}
                      </div>
                      {compare && (
                        <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2 text-[11px] text-[var(--muted)]">
                          <b className="text-[var(--text)]">重跑对比：</b>
                          <span className="ml-2">
                            原模型{' '}
                            {compare.parent.model || r.rerunFromModel || '—'}
                          </span>
                          <span
                            className={
                              compare.costDelta <= 0
                                ? 'ml-2 text-[var(--accent-2)]'
                                : 'ml-2 text-amber-300'
                            }
                          >
                            成本 {compare.costDelta <= 0 ? '降低' : '增加'}{' '}
                            {formatCost(Math.abs(compare.costDelta))}
                          </span>
                          <span
                            className={
                              compare.latencyDelta <= 0
                                ? 'ml-2 text-[var(--accent-2)]'
                                : 'ml-2 text-amber-300'
                            }
                          >
                            延迟 {compare.latencyDelta <= 0 ? '降低' : '增加'}{' '}
                            {formatLatency(Math.abs(compare.latencyDelta))}
                          </span>
                          <span className="ml-2">
                            结果 {compare.parent.success ? '✓' : '✗'} →{' '}
                            {r.success ? '✓' : '✗'}
                          </span>
                        </div>
                      )}
                      <RerunButton
                        runId={r.id}
                        currentModel={r.model}
                        currentModelVersion={r.modelVersion}
                        models={
                          (typeof r.skill === 'object' &&
                          r.skill?.currentVersion &&
                          typeof r.skill.currentVersion === 'object'
                            ? r.skill.currentVersion?.recommendedModels?.cloud
                            : undefined) || []
                        }
                      />
                    </div>
                  </details>
                </li>
              )
            })}
          </ul>
        )}
      </div>
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
              <span className="text-[var(--muted)]">
                {c.description || c.actionType}
              </span>
              <span
                className={
                  c.points >= 0
                    ? 'text-[var(--accent-2)]'
                    : 'text-[var(--danger)]'
                }
              >
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
                  <Link
                    href={`/skills/${s.slug}`}
                    className="hover:text-[var(--accent)]"
                  >
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
            <li
              key={i.id}
              className="flex items-center justify-between gap-2 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <code className="font-mono">{i.code}</code>
                <CopyButton value={i.code} label="复制" />
              </div>
              <span className="text-xs text-[var(--muted)]">
                {i.status === 'unused'
                  ? '未使用'
                  : i.status === 'used'
                    ? '已使用'
                    : i.status}
              </span>
            </li>
          ))}
        </ul>
      )
  } else if (section === 'notifications') {
    const notifs = await payload.find({
      collection: 'notifications',
      where: { user: { equals: uid } },
      depth: 0,
      limit: PAGE_SIZE,
      page,
      sort: '-createdAt',
      overrideAccess: true,
    })
    totalPages = notifs.totalPages || 1
    const hasUnread = (notifs.docs as any[]).some((n) => !n.read)
    body =
      notifs.docs.length === 0 ? (
        <Empty>
          暂无通知。有人收藏/评价你的 Skill 或悬赏有进展时会通知你。
        </Empty>
      ) : (
        <>
          <MarkNotificationsRead hasUnread={hasUnread} />
          <ul className="divide-y divide-[var(--border)] text-sm">
            {(notifs.docs as any[]).map((n) => {
              const inner = (
                <div
                  className={`flex items-start gap-2 py-2 ${n.read ? '' : 'font-medium'}`}
                >
                  {!n.read && (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
                  )}
                  <div className={`min-w-0 ${n.read ? 'pl-4' : ''}`}>
                    <div className="truncate">{n.title}</div>
                    {n.body && (
                      <div className="text-xs text-[var(--muted)]">
                        {n.body}
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-[var(--faint)]">
                      {timeAgo(n.createdAt)}
                    </div>
                  </div>
                </div>
              )
              return (
                <li key={n.id}>
                  {n.link ? (
                    <Link
                      href={n.link}
                      className="block hover:text-[var(--accent)]"
                    >
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )
    // 查看即已读：由客户端组件挂载后调用标记端点（不在 render 内 mutate，避免 Link prefetch 提前触发）
  }

  return (
    <Section title={title}>
      {body}
      <Pagination
        page={page}
        totalPages={totalPages}
        basePath={`/console/${section}`}
        params={sp}
      />
    </Section>
  )
}
