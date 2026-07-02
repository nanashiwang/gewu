import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentUser } from '@/lib/auth'
import { SkillCard } from '@/components/SkillCard'
import { ForkButton } from '@/components/ForkButton'

export const dynamic = 'force-dynamic'

async function getData() {
  const payload = await getPayloadClient()
  const [featured, recent, categories, stats] = await Promise.all([
    payload.find({
      collection: 'skills',
      where: { and: [{ status: { equals: 'published' } }, { isFeatured: { equals: true } }] },
      depth: 1,
      limit: 6,
      sort: '-skillRank',
    }),
    payload.find({
      collection: 'skills',
      where: { status: { equals: 'published' } },
      depth: 1,
      limit: 8,
      sort: '-createdAt',
    }),
    payload.find({ collection: 'categories', limit: 20, sort: 'order' }),
    payload.find({ collection: 'skills', where: { status: { equals: 'published' } }, limit: 0 }),
  ])
  // 模板：评分最高的几个已发布 Skill，作为"从改一个现成的开始"的起点
  const templates = await payload.find({
    collection: 'skills',
    where: { and: [{ status: { equals: 'published' } }, { visibility: { equals: 'public' } }] },
    depth: 0,
    limit: 3,
    sort: '-skillRank',
  })
  return {
    featured: featured.docs,
    recent: recent.docs,
    categories: categories.docs,
    skillCount: stats.totalDocs,
    templates: templates.docs,
  }
}

export default async function HomePage() {
  const { featured, recent, categories, skillCount, templates } = await getData()
  const user = await getCurrentUser()
  const list = featured.length > 0 ? featured : recent.slice(0, 6)

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section
        className="animate-in card overflow-hidden p-8 sm:p-10"
        style={{ background: 'linear-gradient(135deg, var(--hero-from), var(--hero-to))' }}
      >
        <div className="max-w-2xl">
          <div className="mb-2 text-sm font-semibold tracking-wide text-[var(--accent)]">
            衡术 Hengshu
          </div>
          <h1 className="text-3xl font-bold tracking-tight">经过评测的 AI Skill 市场</h1>
          <p className="mt-2 text-[13px] font-medium uppercase tracking-wider text-[var(--accent-2)]">
            Verified AI Skills, Powered by Contribution.
          </p>
          <p className="mt-3 text-[var(--muted)]">
            发现、运行、评测和复用高质量 AI 技能。每个 Skill 都是可运行、可评测、可计费的能力包——
            告诉你「这个任务用哪个模型最省、最准、最稳」。
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/skills"
              className="btn btn-primary px-6 py-2.5"
            >
              浏览 Skill 市场
            </Link>
            <Link
              href="/rank"
              className="btn btn-secondary px-6 py-2.5"
            >
              查看排行榜
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

      {/* 分类 */}
      <section>
        <div className="mb-3 flex flex-wrap gap-2">
          {categories.map((c: any) => (
            <Link key={c.id} href={`/skills?category=${c.slug}`} className="chip">
              {c.icon} {c.name}
            </Link>
          ))}
        </div>
      </section>

      {/* 从改一个现成的开始（供给冷启动） */}
      {templates.length > 0 && (
        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold">从改一个现成的开始</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              不必从零写 Prompt——fork 一个跑通的 Skill 到你名下，改成你自己的版本再发布。
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {(templates as any[]).map((t) => (
              <div key={t.id} className="card flex flex-col gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/skills/${t.slug}`} className="font-medium hover:text-[var(--accent)]">
                    {t.title}
                  </Link>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">{t.description}</p>
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
          <h2 className="text-lg font-semibold">{featured.length > 0 ? '精选 Skill' : '最新 Skill'}</h2>
          <Link href="/skills" className="text-sm text-[var(--accent)] hover:underline">
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
      暂无 Skill。运行 <code className="text-[var(--text)]">npm run seed</code> 注入官方 Skill。
    </div>
  )
}
