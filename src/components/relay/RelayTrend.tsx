import { timeAgo } from '@/lib/format'

export function RelayTrend({ checks }: { checks: any[] }) {
  const done = checks.filter((check) => check.status === 'done' && typeof check.score === 'number').slice(0, 24).reverse()
  if (done.length === 0) return <div className="text-sm text-[var(--muted)]">还没有已完成的检测记录。</div>
  return (
    <div className="space-y-3">
      <div className="flex h-44 items-end gap-1 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3" aria-label="历史质量趋势">
        {done.map((check) => (
          <div key={check.id} className="group relative min-w-1 flex-1 rounded-t bg-[var(--accent)]" style={{ height: `${Math.max(3, check.score)}%` }} title={`${check.score.toFixed(0)} 分 · ${new Date(check.finishedAt || check.createdAt).toLocaleString('zh-CN')}`}>
            <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-[10px] group-hover:block">{check.score.toFixed(0)}</span>
          </div>
        ))}
      </div>
      <ul className="divide-y divide-[var(--border)] text-sm">
        {checks.slice(0, 10).map((check) => (
          <li key={check.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{check.source === 'scheduled' ? '定时' : '手动'} · {check.model}</span>
            <span className="text-xs text-[var(--muted)]">{check.status === 'done' ? `${Number(check.score).toFixed(0)} 分 / ${check.grade}` : check.status === 'error' ? '失败' : '进行中'} · {timeAgo(check.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
