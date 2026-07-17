import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentUser } from '@/lib/auth'
import { SkillCard } from '@/components/SkillCard'
import { ForkButton } from '@/components/ForkButton'
import { resolveEssentialStarterPack } from '@/lib/essentialStarterPack'

export const dynamic = 'force-dynamic'

async function getData() {
  const payload = await getPayloadClient()
  const [featured, recent, starterPack, categories, stats] = await Promise.all([
    payload.find({
      collection: 'skills',
      where: {
        and: [
          { status: { equals: 'published' } },
          { visibility: { equals: 'public' } },
          { isFeatured: { equals: true } },
        ],
      },
      depth: 1,
      limit: 6,
      sort: '-skillRank',
    }),
    payload.find({
      collection: 'skills',
      where: {
        and: [
          { status: { equals: 'published' } },
          { visibility: { equals: 'public' } },
        ],
      },
      depth: 1,
      limit: 8,
      sort: '-createdAt',
    }),
    resolveEssentialStarterPack(payload, { limit: 3, page: 1 }),
    payload.find({ collection: 'categories', limit: 20, sort: 'order' }),
    payload.find({
      collection: 'skills',
      where: {
        and: [
          { status: { equals: 'published' } },
          { visibility: { equals: 'public' } },
        ],
      },
      limit: 0,
    }),
  ])
  // 模板：评分最高的几个已发布 Skill，作为"从改一个现成 Skill 开始"的起点
  const templates = await payload.find({
    collection: 'skills',
    where: {
      and: [
        { status: { equals: 'published' } },
        { visibility: { equals: 'public' } },
      ],
    },
    depth: 0,
    limit: 3,
    sort: '-skillRank',
  })
  const essentials = {
    docs: starterPack.entries.map((entry: any) => ({
      ...entry.skill,
      isEssential: true,
      essentialReason: entry.reason || entry.skill?.essentialReason,
      starterExample: entry.starterExample,
    })),
  }
  const cardSkills = [...featured.docs, ...recent.docs, ...essentials.docs]
  const ids = [...new Set(cardSkills.map((s: any) => s.id).filter(Boolean))]
  const passportEntries = await Promise.all(
    ids.map(async (skillId) => {
      const passports = await payload.find({
        collection: 'skill-passports' as any,
        where: {
          and: [
            { skill: { equals: skillId } },
            { status: { equals: 'current' } },
          ],
        },
        sort: '-lastVerifiedAt',
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      return [skillId, passports.docs[0] || null] as const
    }),
  )
  const passportBySkillId = new Map(passportEntries)
  const withPassport = (docs: any[]) =>
    docs.map((skill) => ({
      ...skill,
      passport: passportBySkillId.get(skill.id) || null,
    }))
  return {
    featured: withPassport(featured.docs as any[]),
    recent: withPassport(recent.docs as any[]),
    essentials: withPassport(essentials.docs as any[]),
    categories: categories.docs,
    skillCount: stats.totalDocs,
    templates: templates.docs,
  }
}

export default async function HomePage() {
  const { featured, recent, essentials, categories, skillCount, templates } =
    await getData()
  const user = await getCurrentUser()
  const list = featured.length > 0 ? featured : recent.slice(0, 6)

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section
        className="animate-in card overflow-hidden p-8 sm:p-10"
        style={{
          background:
            'linear-gradient(135deg, var(--hero-from), var(--hero-to))',
        }}
      >
        <div className="max-w-2xl">
          <div className="mb-2 text-sm font-semibold tracking-wide text-[var(--accent)]">
            格物
          </div>
          <h1 className="text-3xl font-bold tracking-tight">
            AI Skill 的可信与兼容控制平面
          </h1>
          <p className="mt-2 text-[13px] font-medium uppercase tracking-wider text-[var(--accent-2)]">
            Passport · Compatibility · Runner · Enterprise Registry
          </p>
          <p className="mt-3 text-[var(--muted)]">
            让 AI Skill
            像软件包一样拥有身份、版本、签名、兼容证据和失败记录。你已经有模型了，
            格物 负责证明这个 Skill 是否可信、是否适配你的模型、网关、本地 Runner
            和企业环境。
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/skills?essential=1"
              className="btn btn-primary px-6 py-2.5"
            >
              先跑必备 Skill
            </Link>
            <Link href="/skills" className="btn btn-secondary px-6 py-2.5">
              浏览 Skill 市场
            </Link>
            <Link href="/failures" className="btn btn-secondary px-6 py-2.5">
              查看失败库
            </Link>
          </div>
          <div className="mt-6 flex gap-6 text-sm text-[var(--muted)]">
            <span>
              <b className="text-[var(--text)]">{skillCount}</b> 个已发布 Skill
            </span>
            <span>
              <b className="text-[var(--text)]">{categories.length}</b> 个分类
            </span>
          </div>
        </div>
      </section>

      {/* 新手快速尝鲜 */}
      {essentials.length > 0 && (
        <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-5">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-emerald-100">
                先跑这 3 个必备 Skill
              </h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                给新用户的最短路径：低风险、用途明确，先看到一次稳定输出，再去探索市场。
              </p>
            </div>
            <Link
              href="/skills?essential=1"
              className="text-sm text-emerald-200 hover:underline"
            >
              查看全部必备 →
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {(essentials as any[]).map((s) => (
              <SkillCard key={s.id} skill={s} />
            ))}
          </div>
        </section>
      )}

      {/* 分类 */}
      <section>
        <div className="mb-3 flex flex-wrap gap-2">
          {categories.map((c: any) => (
            <Link
              key={c.id}
              href={`/skills?category=${c.slug}`}
              className="chip"
            >
              {c.icon} {c.name}
            </Link>
          ))}
        </div>
      </section>

      {/* 从改一个现成 Skill 开始（供给冷启动） */}
      {templates.length > 0 && (
        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold">从改一个现成 Skill 开始</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              不必从零搭能力契约——fork 一个已有运行证据的
              Skill，到你名下改成自己的版本再发布。
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {(templates as any[]).map((t) => (
              <div key={t.id} className="card flex flex-col gap-3 p-4">
                <div className="min-w-0">
                  <Link
                    href={`/skills/${t.slug}`}
                    className="font-medium hover:text-[var(--accent)]"
                  >
                    {t.title}
                  </Link>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">
                    {t.description}
                  </p>
                </div>
                <div className="mt-auto">
                  <ForkButton slug={t.slug} loggedIn={!!user} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 精选 Skill */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {featured.length > 0 ? '精选 Skill' : '最新 Skill'}
          </h2>
          <Link
            href="/skills"
            className="text-sm text-[var(--accent)] hover:underline"
          >
            查看全部 →
          </Link>
        </div>
        {list.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((s: any) => (
              <SkillCard key={s.id} skill={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)]">
      暂无 Skill。运行 <code className="text-[var(--text)]">npm run seed</code>{' '}
      注入官方 Skill。
    </div>
  )
}
