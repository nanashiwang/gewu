import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { Pagination } from '@/components/Pagination'
import { formatNumber, formatPercent } from '@/lib/format'
import { publicContributionUser, publicContributionUserWhere } from '@/lib/userPublic'
import { publicSkillRankExplanation } from '@/lib/skillrank'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

export default async function RankPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const qp = await searchParams
  const payload = await getPayloadClient()
  // 两个榜单各自独立分页：sp=Skill 可信榜页码，up=贡献榜页码
  const skillPage = Math.max(1, parseInt(qp.sp || '1', 10) || 1)
  const userPage = Math.max(1, parseInt(qp.up || '1', 10) || 1)
  const [skills, users] = await Promise.all([
    payload.find({
      collection: 'skills',
      where: {
        and: [
          { status: { equals: 'published' } },
          { visibility: { equals: 'public' } },
        ],
      },
      sort: '-skillRank',
      limit: PAGE_SIZE,
      page: skillPage,
      depth: 1,
    }),
    payload.find({
      collection: 'users',
      where: publicContributionUserWhere(),
      sort: '-contributionScore',
      limit: PAGE_SIZE,
      page: userPage,
      overrideAccess: true,
    }),
  ])
  const passports = await Promise.all(
    (skills.docs as any[]).map(async (skill) => {
      const res = await payload.find({
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
      return [skill.id, res.docs[0] || null] as const
    }),
  )
  const passportBySkillId = new Map(passports)
  const rankGuide = publicSkillRankExplanation({ skillRank: 0 })
  const skillBase = ((skills.page || skillPage) - 1) * PAGE_SIZE
  const userBase = ((users.page || userPage) - 1) * PAGE_SIZE
  const publicUsers = (users.docs as any[]).map(publicContributionUser)

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">可信发现榜</h1>
        <p className="max-w-3xl text-sm text-[var(--muted)]">
          这里不是下载量热榜，而是把可信分、成功率、可信兼容运行和 Passport
          可信档案放在一起，帮助用户先试更可靠的 Skill。
        </p>
      </div>
      <section className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm md:grid-cols-4">
        <div>
          <div className="font-medium text-[var(--text)]">看可信分</div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            综合成功率、格式成功率、成本、延迟、维护和反馈。
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--text)]">看证据强度</div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            可信兼容运行会加权，但采用对数饱和，避免刷样本支配排序。
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--text)]">看 Passport</div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            有 Passport 的条目可打开公开 API，复核身份、基准和证据链。
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--text)]">不看虚火</div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            下载量和普通调用量不是排序依据，样本少只建议先试跑。
          </p>
        </div>
      </section>
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 text-xs text-[var(--muted)]">
        <div className="font-medium text-[var(--text)]">排序口径怎么读</div>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2">
            <div className="text-[var(--text)]">基础可信分 85%</div>
            <div className="mt-1">{rankGuide.formula.baseScore}</div>
          </div>
          <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2">
            <div className="text-[var(--text)]">可信证据 15%</div>
            <div className="mt-1">{rankGuide.formula.trustedEvidence}</div>
          </div>
          <div className="rounded border border-[var(--border)] bg-[var(--bg)] p-2">
            <div className="text-[var(--text)]">饱和防刷</div>
            <div className="mt-1">{rankGuide.formula.saturation}</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {rankGuide.factorWeights.map((factor) => (
            <span key={factor.key} className="rounded-full border border-[var(--border)] px-2 py-1">
              {factor.label} {Math.round(factor.weight * 100)}%
            </span>
          ))}
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <h2 className="mb-1 text-sm font-semibold">Skill 可信榜</h2>
          <p className="mb-3 text-xs text-[var(--muted)]">
            优先看真实成功率、可信兼容运行数和 Passport 可信分；样本少的 Skill
            只适合试用，不适合直接采购。
          </p>
          <ol className="space-y-1 text-sm">
            {skills.docs.map((s: any, i: number) => {
              const rank = skillBase + i + 1
              const passport = passportBySkillId.get(s.id) as any
              const explanation = publicSkillRankExplanation(s, passport)
              const trustedCompatibleRunCount = Number(
                passport?.reliabilitySummary?.trustedCompatibleRunCount ??
                  passport?.evidenceSummary?.trustedCompatibleRunCount ??
                  0,
              )
              return (
                <li key={s.id} className="py-2">
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-6 text-right ${rank <= 3 ? 'font-bold text-[var(--accent)]' : 'text-[var(--muted)]'}`}
                    >
                      {rank}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Link
                        href={`/skills/${s.slug}`}
                        className="block truncate hover:text-[var(--accent)]"
                      >
                        {s.title}
                      </Link>
                      <span className="text-xs text-[var(--muted)]">
                        成功 {formatPercent(s.successRate)} ·{' '}
                        {formatNumber(trustedCompatibleRunCount)} 次可信兼容
                        {passport
                          ? ` · Passport ${Math.round(passport.trustScore || 0)}`
                          : ' · Passport 待生成'}
                      </span>
                    </span>
                    {passport ? (
                      <a
                        href={`/v1/skills/${s.slug}/passport`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      >
                        证据
                      </a>
                    ) : null}
                    <span className="w-10 text-right font-semibold text-[var(--accent)]">
                      {Math.round(s.skillRank || 0)}
                    </span>
                  </div>
                  <details className="ml-9 mt-1 text-xs text-[var(--muted)]">
                    <summary className="cursor-pointer hover:text-[var(--accent)]">
                      为什么排这里：{explanation.customerHint}
                    </summary>
                    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2">
                      <div className="flex flex-wrap gap-2">
                        {explanation.reasons.map((reason) => (
                          <span key={reason} className="rounded-full border border-[var(--border)] px-2 py-0.5">
                            {reason}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2">
                        护栏：{explanation.guardrails.join('；')}。
                      </div>
                    </div>
                  </details>
                </li>
              )
            })}
          </ol>
          <Pagination
            page={skills.page || skillPage}
            totalPages={skills.totalPages || 1}
            basePath="/rank"
            pageKey="sp"
            params={{ up: qp.up }}
          />
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <h2 className="mb-1 text-sm font-semibold">可信贡献榜</h2>
          <p className="mb-3 text-xs text-[var(--muted)]">
            贡献榜用于发现持续维护、反馈和改进 Skill
            的用户，不作为收益或采购承诺。
          </p>
          <ol className="space-y-1 text-sm">
            {publicUsers.map((u: any, i: number) => {
              const rank = userBase + i + 1
              return (
                <li key={u.id} className="flex items-center gap-3 py-1.5">
                  <span
                    className={`w-6 text-right ${rank <= 3 ? 'font-bold text-[var(--accent-2)]' : 'text-[var(--muted)]'}`}
                  >
                    {rank}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{u.username}</span>
                  <span className="text-xs text-[var(--muted)]">
                    Lv.{u.level}
                  </span>
                  <span className="w-14 text-right font-semibold text-[var(--accent-2)]">
                    ⚡ {formatNumber(u.contributionScore)}
                  </span>
                </li>
              )
            })}
          </ol>
          <Pagination
            page={users.page || userPage}
            totalPages={users.totalPages || 1}
            basePath="/rank"
            pageKey="up"
            params={{ sp: qp.sp }}
          />
        </section>
      </div>
    </div>
  )
}
