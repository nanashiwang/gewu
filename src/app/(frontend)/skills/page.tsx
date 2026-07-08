import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { SkillStatusTags } from '@/components/Tag'
import { Pagination } from '@/components/Pagination'
import {
  formatCost,
  formatLatency,
  formatNumber,
  formatPercent,
  timeAgo,
} from '@/lib/format'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

const SORTS = [
  { key: 'skillRank', label: '综合', sort: '-skillRank' },
  { key: 'new', label: '最新', sort: '-createdAt' },
]

type SP = Record<string, string | undefined>

function buildHref(base: SP, patch: SP): string {
  const merged: SP = { ...base, ...patch }
  const qs = Object.entries(merged)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&')
  return qs ? `/skills?${qs}` : '/skills'
}

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const payload = await getPayloadClient()

  const categories = (
    await payload.find({ collection: 'categories', limit: 50, sort: 'order' })
  ).docs
  const activeCat = sp.category
    ? categories.find((c: any) => c.slug === sp.category)
    : null
  const requestedSortKey = sp.sort || 'skillRank'
  const activeSort = SORTS.find((s) => s.key === requestedSortKey) || SORTS[0]
  const sortKey = activeSort.key
  const sort = activeSort.sort
  const q = sp.q?.trim()
  const essentialOnly = sp.essential === '1'

  const where: any = {
    and: [
      { status: { equals: 'published' } },
      { visibility: { equals: 'public' } },
    ],
  }
  if (activeCat) where.and.push({ category: { equals: activeCat.id } })
  if (essentialOnly) where.and.push({ isEssential: { equals: true } })
  if (q) where.and.push({ title: { like: q } })

  const page = Math.max(1, parseInt(sp.page || '1', 10) || 1)
  const essentialWhere: any = {
    and: [
      { status: { equals: 'published' } },
      { visibility: { equals: 'public' } },
      { isEssential: { equals: true } },
    ],
  }
  if (activeCat) essentialWhere.and.push({ category: { equals: activeCat.id } })
  const [res, essential] = await Promise.all([
    payload.find({
      collection: 'skills',
      where,
      depth: 1,
      limit: PAGE_SIZE,
      page,
      sort,
    }),
    page === 1 && !q && !essentialOnly
      ? payload.find({
          collection: 'skills',
          where: essentialWhere,
          depth: 1,
          limit: 6,
          sort: '-skillRank',
        })
      : Promise.resolve({ docs: [] }),
  ])
  const skills = res.docs
  const essentials = essential.docs as any[]
  const passportEntries = await Promise.all(
    [...(skills as any[]), ...essentials].map(async (skill: any) => {
      const passports = await payload.find({
        collection: 'skill-passports' as any,
        where: {
          and: [
            { skill: { equals: skill.id } },
            { status: { equals: 'current' } },
          ],
        },
        sort: '-lastVerifiedAt',
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      return [skill.id, passports.docs[0] || null] as const
    }),
  )
  const passportBySkillId = new Map(passportEntries)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Skill 市场</h1>
          {essentialOnly && (
            <p className="mt-1 text-sm text-[var(--muted)]">
              只看必备 Skill：低风险、输入简单、适合新用户先跑通一次真实结果。
            </p>
          )}
        </div>
        <span className="text-sm text-[var(--muted)]">
          {res.totalDocs} 个 Skill
        </span>
      </div>

      {essentialOnly && (
        <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-4">
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div>
              <div className="font-medium text-emerald-100">
                1. 先看 Passport
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">
                确认身份、签名、兼容证据和达标证书，不盲试黑盒 Prompt。
              </p>
            </div>
            <div>
              <div className="font-medium text-emerald-100">
                2. 用默认输入试跑
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">
                先跑低风险任务，快速看到输出、成本、延迟和格式状态。
              </p>
            </div>
            <div>
              <div className="font-medium text-emerald-100">
                3. 回到私人台账
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">
                在控制台按模型/成功/格式筛选，后续可换模型重跑。
              </p>
            </div>
          </div>
        </section>
      )}

      {essentials.length > 0 && (
        <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-emerald-200">
                必备 Skill
              </h2>
              <p className="text-sm text-[var(--muted)]">
                新用户先跑这几个：低风险、用途明确、最容易快速尝到甜头。
              </p>
            </div>
            <span className="text-xs text-emerald-200">Starter Pack</span>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {essentials.map((s: any) => {
              const passport = passportBySkillId.get(s.id) as any
              const trustedCompatibleRunCount = Number(
                passport?.reliabilitySummary?.trustedCompatibleRunCount ??
                  passport?.evidenceSummary?.trustedCompatibleRunCount ??
                  0,
              )
              return (
                <article
                  key={s.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 transition hover:border-emerald-400/60"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/skills/${s.slug}`}
                      className="min-w-0 truncate font-medium hover:text-emerald-200"
                    >
                      {s.title}
                    </Link>
                    <SkillStatusTags skill={s} />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">
                    {s.description}
                  </p>
                  {s.essentialReason && (
                    <p className="mt-2 line-clamp-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-emerald-100">
                      为什么先跑：{s.essentialReason}
                    </p>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--faint)]">
                    <span>
                      成功率 {formatPercent(s.successRate)} · 可信兼容{' '}
                      {formatNumber(trustedCompatibleRunCount)}
                    </span>
                    <span className="text-emerald-200">
                      Passport{' '}
                      {passport ? Math.round(passport.trustScore || 0) : '待生成'}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <Link
                      href={`/skills/${s.slug}/run`}
                      className="rounded-full border border-emerald-500/40 px-3 py-1 text-emerald-200 hover:border-emerald-300"
                    >
                      直接试跑
                    </Link>
                    <a
                      href={`/v1/skills/${s.slug}/passport`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
                    >
                      看 Passport
                    </a>
                    <Link
                      href={`/console/runs?skillId=${encodeURIComponent(String(s.id))}`}
                      className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--accent)] hover:border-[var(--accent)]"
                    >
                      台账
                    </Link>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {/* 分类筛选 */}
      <div className="flex flex-wrap gap-2">
        <Link
          href={buildHref(sp, {
            category: undefined,
            essential: undefined,
            page: undefined,
          })}
          className={`rounded-full border px-3 py-1 text-sm ${
            !activeCat && !essentialOnly
              ? 'border-[var(--accent)] text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          全部
        </Link>
        <Link
          href={buildHref(sp, {
            essential: essentialOnly ? undefined : '1',
            page: undefined,
          })}
          className={`rounded-full border px-3 py-1 text-sm ${
            essentialOnly
              ? 'border-emerald-400 text-emerald-200'
              : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          ⭐ 必备
        </Link>
        {categories.map((c: any) => (
          <Link
            key={c.id}
            href={buildHref(sp, { category: c.slug, page: undefined })}
            className={`rounded-full border px-3 py-1 text-sm ${
              activeCat?.id === c.id
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            {c.icon} {c.name}
          </Link>
        ))}
      </div>

      {/* 排序 + 搜索 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 text-sm">
          {SORTS.map((s) => (
            <Link
              key={s.key}
              href={buildHref(sp, { sort: s.key, page: undefined })}
              className={`rounded-md px-3 py-1 ${
                sortKey === s.key
                  ? 'bg-[var(--panel-2)] text-[var(--text)]'
                  : 'text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <form method="get" className="flex gap-2">
          {activeCat && (
            <input type="hidden" name="category" value={activeCat.slug ?? ''} />
          )}
          {essentialOnly && <input type="hidden" name="essential" value="1" />}
          <input type="hidden" name="sort" value={sortKey} />
          <input
            name="q"
            defaultValue={q || ''}
            placeholder="搜索 Skill…"
            className="w-48 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:border-[var(--accent)]">
            搜索
          </button>
        </form>
      </div>

      {/* Skill 可信资源表 */}
      {skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)]">
          没有匹配的 Skill。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--panel)] text-left text-xs text-[var(--muted)]">
                <th className="px-3 py-2 font-medium">分类</th>
                <th className="px-3 py-2 font-medium">Skill</th>
                <th className="px-3 py-2 font-medium">作者</th>
                <th className="px-3 py-2 text-right font-medium">Passport</th>
                <th className="px-3 py-2 text-right font-medium">可信分</th>
                <th className="px-3 py-2 text-right font-medium">成功率</th>
                <th className="px-3 py-2 text-right font-medium">成本</th>
                <th className="px-3 py-2 text-right font-medium">耗时</th>
                <th className="px-3 py-2 text-right font-medium">可信兼容</th>
                <th className="px-3 py-2 text-right font-medium">收藏</th>
                <th className="px-3 py-2 font-medium">更新</th>
                <th className="px-3 py-2 text-right font-medium">行动</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s: any) => {
                const cat = typeof s.category === 'object' ? s.category : null
                const author = typeof s.author === 'object' ? s.author : null
                const passport = passportBySkillId.get(s.id) as any
                const trustedCompatibleRunCount = Number(
                  passport?.reliabilitySummary?.trustedCompatibleRunCount ??
                    passport?.evidenceSummary?.trustedCompatibleRunCount ??
                    0,
                )
                return (
                  <tr
                    key={s.id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--panel)]"
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-[var(--muted)]">
                      {cat ? `${cat.icon} ${cat.name}` : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/skills/${s.slug}`}
                        className="font-medium hover:text-[var(--accent)]"
                      >
                        {s.title}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <SkillStatusTags skill={s} />
                      </div>
                      {s.isEssential && s.essentialReason && (
                        <div className="mt-1 max-w-md text-xs text-emerald-200">
                          为什么先跑：{s.essentialReason}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-[var(--muted)]">
                      {author?.username || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      {passport ? (
                        <a
                          href={`/v1/skills/${s.slug}/passport`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-200 hover:underline"
                        >
                          {Math.round(passport.trustScore || 0)}
                        </a>
                      ) : (
                        <span className="text-[var(--muted)]">待生成</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-[var(--accent)]">
                      {Math.round(s.skillRank || 0)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {formatPercent(s.successRate)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {formatCost(s.avgCost)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {formatLatency(s.avgLatencyMs)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {formatNumber(trustedCompatibleRunCount)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {formatNumber(s.favoriteCount)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-[var(--muted)]">
                      {timeAgo(s.lastUpdatedAt || s.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs">
                      <Link
                        href={`/skills/${s.slug}/run`}
                        className="text-[var(--accent)] hover:underline"
                      >
                        试跑
                      </Link>
                      <Link
                        href={`/console/runs?skillId=${encodeURIComponent(String(s.id))}`}
                        className="ml-2 text-[var(--accent)] hover:underline"
                      >
                        台账
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={res.page || page}
        totalPages={res.totalPages || 1}
        basePath="/skills"
        params={sp}
      />
    </div>
  )
}
