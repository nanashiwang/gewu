import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentUser } from '@/lib/auth'
import { BountyActions } from '@/components/BountyActions'
import { formatNumber, timeAgo } from '@/lib/format'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  open: '开放中',
  accepted: '已接单',
  submitted: '已提交',
  completed: '已完成',
  disputed: '争议中',
  cancelled: '已取消',
}

export default async function BountyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const payload = await getPayloadClient()
  const bounty = await payload.findByID({ collection: 'bounties', id, depth: 1 }).catch(() => null)
  if (!bounty) notFound()
  const creator = typeof bounty.creator === 'object' ? bounty.creator : null
  const acceptor = typeof bounty.acceptedBy === 'object' ? bounty.acceptedBy : null
  const submitted = typeof bounty.submittedSkill === 'object' ? bounty.submittedSkill : null

  const user = await getCurrentUser()
  const uid = (user as any)?.id
  const creatorId = typeof bounty.creator === 'object' ? (bounty.creator as any)?.id : bounty.creator
  const acceptorId = typeof bounty.acceptedBy === 'object' ? (bounty.acceptedBy as any)?.id : bounty.acceptedBy
  const role: 'creator' | 'acceptor' | 'other' =
    uid && uid === creatorId ? 'creator' : uid && uid === acceptorId ? 'acceptor' : 'other'

  return (
    <div className="space-y-4">
      <Link href="/bounties" className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
        ← 返回悬赏区
      </Link>
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
              {STATUS_LABELS[bounty.status as string] || bounty.status}
            </span>
            <h1 className="mt-2 text-2xl font-bold">{bounty.title}</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {creator?.username || '匿名'} · {timeAgo(bounty.createdAt)}
              {bounty.dueAt ? ` · 截止 ${new Date(bounty.dueAt).toLocaleDateString('zh-CN')}` : ''}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xl font-bold text-[var(--accent-2)]">⚡ {formatNumber(bounty.rewardPoints)}</div>
            <div className="text-xs text-[var(--muted)]">
              {(bounty as any).frozenPoints ? '已冻结术值' : '贡献值赏金'}
            </div>
          </div>
        </div>
        <div className="mt-4 whitespace-pre-wrap text-sm">{bounty.description || '（无详细说明）'}</div>

        {(acceptor || submitted) && (
          <div className="mt-4 flex flex-wrap gap-4 border-t border-[var(--border)] pt-4 text-sm text-[var(--muted)]">
            {acceptor && <span>接单人：{acceptor.username}</span>}
            {submitted && (
              <span>
                交付：
                <Link href={`/skills/${submitted.slug}`} className="link-accent ml-1">
                  {submitted.title}
                </Link>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold">参与</h2>
        <BountyActions bountyId={id} status={bounty.status as string} role={role} loggedIn={!!user} />
      </div>
    </div>
  )
}
