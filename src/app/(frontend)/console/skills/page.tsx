import Link from 'next/link'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentUser } from '@/lib/auth'
import { SkillStatusTags } from '@/components/Tag'
import { Pagination } from '@/components/Pagination'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 30

// 创作者工作台·我的作品（列出当前用户发布的所有 Skill，含 pending/rejected 状态与指标）
export default async function MySkillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page || '1', 10) || 1)
  const user = await getCurrentUser()
  const payload = await getPayloadClient()
  const res = user
    ? await payload.find({
        collection: 'skills',
        where: { author: { equals: user.id } },
        sort: '-createdAt',
        limit: PAGE_SIZE,
        page,
        overrideAccess: true,
      })
    : { docs: [] as any[], totalPages: 1 }
  const skills = res.docs as any[]

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">我的作品</h1>
        <Link href="/console/skills/new" className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white">
          + 发布 Skill
        </Link>
      </div>
      {skills.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          还没有作品。
          <Link href="/console/skills/new" className="text-[var(--accent)]">
            发布第一个 Skill
          </Link>
          ，或从改一个现成的开始。
        </p>
      ) : (
        <ul className="space-y-2">
          {skills.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-3"
            >
              <div>
                <Link href={`/skills/${s.slug}`} className="font-medium hover:text-[var(--accent)]">
                  {s.title}
                </Link>
                <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                  <SkillStatusTags skill={s} />
                  <span>· {s.runCount || 0} 次运行</span>
                  {s.localScore ? <span>· LocalScore {s.localScore}</span> : null}
                </div>
              </div>
              <Link href={`/skills/${s.slug}`} className="text-xs text-[var(--accent)]">
                查看/预览
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={page} totalPages={res.totalPages || 1} basePath="/console/skills" params={sp} />
    </div>
  )
}
