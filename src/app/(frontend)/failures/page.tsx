import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { aggregateFailureKnowledge } from '@/lib/failureKnowledge'
import { getPayloadClient } from '@/lib/payload'
import { CreateAdapterButton } from '@/components/failures/CreateAdapterButton'
import { buildFailureCaseWhere, isPublicFailureCase } from '@/lib/failureCasePublic'
import { isPublicAdapterProfile } from '@/lib/adapterProfilePublic'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '失败知识库 · 衡术 Hengshu',
  description: '基于真实运行回流的模型失败模式摘要：症状、可能原因与修复方向。',
}

function sourceLabel(source: string) {
  return source === 'benchmark'
    ? '系统评测'
    : source === 'online'
      ? '在线'
      : source === 'verified'
        ? '已验证'
        : source === 'community'
          ? '社区'
          : source
}

function topBreakdown(value: unknown, limit = 3): Array<[string, unknown]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, limit)
}

type SP = Record<string, string | undefined>

function paramsFromSearch(sp: SP) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    if (value) params.set(key, value)
  }
  return params
}

function hasFailureFilters(sp: SP) {
  return Boolean(
    sp.errorType ||
    sp.modelName ||
    sp.modelVersion ||
    sp.status ||
    sp.skillId ||
    sp.skill ||
    sp.profileKey ||
    sp.inputBucket ||
    sp.source,
  )
}

function relationId(value: any) {
  if (!value) return ''
  return typeof value === 'object' ? String(value.id || '') : String(value)
}

function canMaintainFailureCase(user: any, failureCase: any) {
  if (!user) return false
  if (['admin', 'reviewer'].includes(String(user.role || ''))) return true
  const skill = typeof failureCase.skill === 'object' ? failureCase.skill : null
  return relationId(skill?.author) === String(user.id)
}

export default async function FailuresPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const [payload, user] = await Promise.all([
    getPayloadClient(),
    getCurrentUser(),
  ])
  const where = buildFailureCaseWhere(paramsFromSearch(sp))
  const filtersActive = hasFailureFilters(sp)
  const casesRes = await payload
    .find({
      collection: 'failure-cases' as any,
      where,
      depth: 1,
      limit: 60,
      overrideAccess: true,
      sort: '-occurrenceCount',
    })
    .catch(() => ({ docs: [] as any[] }))
  const cases = (casesRes.docs as any[]).filter(isPublicFailureCase)
  const adapterMap = new Map<string, any[]>()
  if (cases.length > 0) {
    await Promise.all(
      cases.map(async (failureCase) => {
        const res = await payload
          .find({
            collection: 'adapter-profiles' as any,
            where: {
              and: [
                { sourceFailureCase: { equals: failureCase.id } },
                { status: { equals: 'active' } },
              ],
            },
            depth: 1,
            limit: 5,
            overrideAccess: true,
            sort: '-liftScore',
          })
          .catch(() => ({ docs: [] as any[] }))
        adapterMap.set(String(failureCase.id), (res.docs as any[]).filter(isPublicAdapterProfile))
      }),
    )
  }
  const compatReports =
    cases.length > 0 || filtersActive
      ? []
      : (
          (
            await payload.find({
              collection: 'compat-reports',
              depth: 1,
              limit: 2000,
              overrideAccess: true,
              sort: '-createdAt',
            })
          ).docs as any[]
        ).filter((report) => {
          const skill = typeof report.skill === 'object' ? report.skill : null
          return skill?.status === 'published' && skill?.visibility === 'public'
        })
  const groups =
    cases.length > 0 || filtersActive
      ? []
      : aggregateFailureKnowledge(compatReports, 60)

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent-2)]">
          Negative Knowledge
        </p>
        <h1 className="mt-1 text-2xl font-semibold">失败知识库</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">
          按 Skill × 输入规模档 ×
          错误类型聚合任务失败画像，并记录模型分布；不公开
          prompt、输出原文或逐条时序。
          公开页给症状与根因摘要；具体修复模板只给作者、审核员或管理员用于生成 Adapter 草稿。
        </p>
        <div className="mt-4 grid gap-3 text-xs md:grid-cols-3">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <div className="font-semibold text-[var(--text)]">
              1. 发现失败模式
            </div>
            <p className="mt-1 text-[var(--muted)]">
              把零散报错聚合成可复用的负知识，而不是只留在单次运行日志里。
            </p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <div className="font-semibold text-[var(--text)]">
              2. 生成 Adapter 草稿
            </div>
            <p className="mt-1 text-[var(--muted)]">
              作者登录后可从 FailureCase 生成补丁草稿，修
              prompt、schema、解码或重试策略。
            </p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <div className="font-semibold text-[var(--text)]">3. 复验 lift</div>
            <p className="mt-1 text-[var(--muted)]">
              启用后通过
              benchmark/真实回流比较前后成功率，把修复效果写回证据快照。
            </p>
          </div>
        </div>
      </div>

      <form
        action="/failures"
        className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4"
      >
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-7">
          <label className="space-y-1 text-xs text-[var(--muted)]">
            错误类型
            <input
              name="errorType"
              defaultValue={sp.errorType || ''}
              placeholder="json_parse_error"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            模型
            <input
              name="modelName"
              defaultValue={sp.modelName || ''}
              placeholder="qwen-plus"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            模型版本
            <input
              name="modelVersion"
              defaultValue={sp.modelVersion || ''}
              placeholder="2026-07-01"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            Skill ID
            <input
              name="skillId"
              defaultValue={sp.skillId || sp.skill || ''}
              placeholder="skill id"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            输入档
            <input
              name="inputBucket"
              defaultValue={sp.inputBucket || ''}
              placeholder="500-2k"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            来源
            <select
              name="source"
              defaultValue={sp.source || ''}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            >
              <option value="">全部</option>
              <option value="benchmark">系统评测</option>
              <option value="online">在线</option>
              <option value="verified">已验证</option>
              <option value="community">社区</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            状态
            <select
              name="status"
              defaultValue={sp.status || ''}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            >
              <option value="">全部</option>
              <option value="observed">observed</option>
              <option value="confirmed">confirmed</option>
              <option value="mitigated">mitigated</option>
              <option value="ignored">ignored</option>
            </select>
          </label>
        </div>
        <label className="mt-3 block space-y-1 text-xs text-[var(--muted)]">
          Profile Key
          <input
            name="profileKey"
            defaultValue={sp.profileKey || ''}
            placeholder="skill×输入档×errorType"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs text-[var(--text)]"
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-black"
          >
            筛选失败画像
          </button>
          {filtersActive ? (
            <Link
              href="/failures"
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)] hover:text-[var(--text)]"
            >
              清空筛选
            </Link>
          ) : null}
          <span className="text-xs text-[var(--faint)]">
            公开 API 同步支持这些过滤条件，方便企业/Runner 定向查负知识。
          </span>
        </div>
      </form>

      {filtersActive && cases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)]">
          当前筛选没有命中的失败画像。
        </div>
      ) : cases.length === 0 && groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)]">
          还没有失败样本。在线运行或 benchmark
          出现失败后，这里会自动聚合负知识。
        </div>
      ) : cases.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {cases.map((c) => {
            const skill = typeof c.skill === 'object' ? c.skill : null
            const adapters = adapterMap.get(String(c.id)) || []
            const sourceBreakdown =
              c.sourceBreakdown &&
              typeof c.sourceBreakdown === 'object' &&
              !Array.isArray(c.sourceBreakdown)
                ? c.sourceBreakdown
                : {}
            const modelBreakdown = topBreakdown(c.modelBreakdown)
            const canCreateAdapter = canMaintainFailureCase(user, c)
            return (
              <article
                key={c.id}
                className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-xs text-[var(--muted)]">
                        {c.status || 'observed'}
                      </span>
                      <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-mono text-xs">
                        {c.errorType}
                      </span>
                    </div>
                    <h2 className="mt-2 text-base font-semibold">{c.title}</h2>
                    <p className="mt-1 font-mono text-xs text-[var(--accent)]">
                      {c.profileKey || `${c.errorType}|${c.modelName}`}
                    </p>
                  </div>
                  <div className="text-right text-xs text-[var(--muted)]">
                    <div className="text-lg font-semibold text-[var(--text)]">
                      {c.occurrenceCount || 0}
                    </div>
                    <div>{c.affectedSkillCount || 0} 个 Skill</div>
                  </div>
                </div>

                <div className="mt-3 space-y-2 text-sm">
                  <p>
                    <b>症状：</b>
                    <span className="text-[var(--muted)]">
                      {c.symptom || '待补充'}
                    </span>
                  </p>
                  <p>
                    <b>可能原因：</b>
                    <span className="text-[var(--muted)]">
                      {c.likelyCause || '待归因'}
                    </span>
                  </p>
                </div>

                <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
                  <b>客户怎么用：</b>
                  <div className="mt-2 grid gap-2 text-[var(--muted)] sm:grid-cols-2">
                    <span>1. 对照错误类型/输入档，判断是否命中同类失败。</span>
                    <span>2. 看模型画像，确认是否集中在某个模型版本。</span>
                    <span>3. 作者可生成 Adapter 草稿，普通用户可看是否已有验证修复。</span>
                    <span>4. 通过证据验签复核这条失败画像来源。</span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                  {c.primaryInputBucket && (
                    <span>主输入：{c.primaryInputBucket}</span>
                  )}
                  {Array.isArray(c.inputBuckets) &&
                    c.inputBuckets.length > 0 && (
                      <span>输入：{c.inputBuckets.join(' / ')}</span>
                    )}
                  {Array.isArray(c.outputBuckets) &&
                    c.outputBuckets.length > 0 && (
                      <span>输出：{c.outputBuckets.join(' / ')}</span>
                    )}
                  {modelBreakdown.map(([model, count]) => (
                    <span key={model}>
                      {model}×{String(count)}
                    </span>
                  ))}
                  {Object.entries(sourceBreakdown).map(([source, count]) => (
                    <span key={source}>
                      {sourceLabel(source)}×{String(count)}
                    </span>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                  {skill ? (
                    <span>
                      代表 Skill：
                      <Link
                        href={`/skills/${skill.slug}`}
                        className="ml-1 text-[var(--accent)] hover:underline"
                      >
                        {skill.title || skill.slug}
                      </Link>
                    </span>
                  ) : null}
                  {c.modelName ? (
                    <Link
                      href={`/models?modelName=${encodeURIComponent(String(c.modelName))}${
                        c.primaryModelVersion ? `&modelVersion=${encodeURIComponent(String(c.primaryModelVersion))}` : ''
                      }`}
                      className="text-[var(--accent)] hover:underline"
                    >
                      模型画像
                    </Link>
                  ) : null}
                  {c.modelName ? (
                    <a
                      href={`/v1/adapters?modelName=${encodeURIComponent(String(c.modelName))}&failureId=${encodeURIComponent(String(c.id))}${
                        c.primaryModelVersion ? `&modelVersion=${encodeURIComponent(String(c.primaryModelVersion))}` : ''
                      }`}
                      className="text-[var(--accent)] hover:underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Adapter API
                    </a>
                  ) : null}
                  <Link
                    href={`/verify?targetType=failure_case&targetId=${encodeURIComponent(String(c.id))}`}
                    className="text-[var(--accent)] hover:underline"
                  >
                    证据验签
                  </Link>
                </div>

                {adapters.length > 0 && (
                  <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
                    <b>此失败已验证 Adapter：</b>
                    <div className="mt-2 space-y-1 text-[var(--muted)]">
                      {adapters.map((a) => (
                        <div
                          key={a.id}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span>{a.title}</span>
                          <span>
                            <span
                              className={
                                Number(a.liftScore || 0) > 0
                                  ? 'text-[var(--accent-2)]'
                                  : 'text-[var(--faint)]'
                              }
                            >
                              lift {Number(a.liftScore || 0).toFixed(1)} · 前{' '}
                              {a.beforeMetrics?.samples || 0} / 后{' '}
                              {a.afterMetrics?.samples || 0}
                            </span>
                            <Link
                              href={`/verify?targetType=adapter_profile&targetId=${encodeURIComponent(String(a.id))}`}
                              className="ml-2 text-[var(--accent)] hover:underline"
                            >
                              证据
                            </Link>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {canCreateAdapter ? (
                  <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-xs">
                    <div>
                      <b>修复模板：</b>
                      <span className="text-[var(--muted)]">
                        {c.repairTemplate || '待补充'}
                      </span>
                    </div>
                    <div className="mt-2">
                      <b>复验：</b>
                      <span className="text-[var(--muted)]">
                        {c.verifyTemplate || '待补充'}
                      </span>
                    </div>
                    {canCreateAdapter ? (
                      <CreateAdapterButton failureId={String(c.id)} />
                    ) : (
                      <div className="mt-3 rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[var(--muted)]">
                        只有该 Skill 作者、审核员或管理员可以从此失败生成 Adapter 草稿。
                      </div>
                    )}
                  </div>
                ) : user ? (
                  <div className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
                    修复模板会转成 Adapter 草稿，只有该 Skill 作者、审核员或管理员可查看和生成。
                  </div>
                ) : (
                  <div className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
                    登录后可查看是否有修复模板；具体模板仅作者、审核员或管理员可见。
                    <Link href="/login" className="ml-1 text-[var(--accent)]">
                      去登录
                    </Link>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <article
              key={g.profileKey}
              className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-xs text-[var(--muted)]">
                      {g.meta.layer}
                    </span>
                    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-mono text-xs">
                      {g.errorType}
                    </span>
                  </div>
                  <h2 className="mt-2 text-base font-semibold">
                    {g.meta.label}
                  </h2>
                  <p className="mt-1 font-mono text-xs text-[var(--accent)]">
                    {g.profileKey}
                  </p>
                </div>
                <div className="text-right text-xs text-[var(--muted)]">
                  <div className="text-lg font-semibold text-[var(--text)]">
                    {g.count}
                  </div>
                  <div>{g.skillCount} 个 Skill</div>
                </div>
              </div>

              <div className="mt-3 space-y-2 text-sm">
                <p>
                  <b>症状：</b>
                  <span className="text-[var(--muted)]">{g.meta.symptom}</span>
                </p>
                <p>
                  <b>可能原因：</b>
                  <span className="text-[var(--muted)]">
                    {g.meta.likelyCause}
                  </span>
                </p>
                <p>
                  <b>公开修复方向：</b>
                  <span className="text-[var(--muted)]">
                    {g.meta.publicFixHint}
                  </span>
                </p>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                <span>主输入：{g.primaryInputBucket}</span>
                {g.inputBuckets.length > 0 && (
                  <span>输入：{g.inputBuckets.join(' / ')}</span>
                )}
                {g.outputBuckets.length > 0 && (
                  <span>输出：{g.outputBuckets.join(' / ')}</span>
                )}
                {topBreakdown(g.modelBreakdown).map(([model, count]) => (
                  <span key={model}>
                    {model}×{String(count)}
                  </span>
                ))}
                {Object.entries(g.sourceBreakdown).map(([source, count]) => (
                  <span key={source}>
                    {sourceLabel(source)}×{count}
                  </span>
                ))}
              </div>

              {g.sampleSkills.length > 0 && (
                <div className="mt-3 text-xs text-[var(--muted)]">
                  关联 Skill：
                  {g.sampleSkills.map((s, i) => (
                    <span key={s.id}>
                      {i > 0 ? '、' : ''}
                      {s.slug ? (
                        <Link
                          href={`/skills/${s.slug}`}
                          className="text-[var(--accent)] hover:underline"
                        >
                          {s.title}
                        </Link>
                      ) : (
                        s.title
                      )}
                    </span>
                  ))}
                </div>
              )}

              {user ? (
                <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-xs">
                  <div>
                    <b>修复模板：</b>
                    <span className="text-[var(--muted)]">
                      {g.meta.repairTemplate}
                    </span>
                  </div>
                  <div className="mt-2">
                    <b>复验：</b>
                    <span className="text-[var(--muted)]">
                      {g.meta.verifyTemplate}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
                  登录后查看修复模板与复验步骤。
                  <Link href="/login" className="ml-1 text-[var(--accent)]">
                    去登录
                  </Link>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
