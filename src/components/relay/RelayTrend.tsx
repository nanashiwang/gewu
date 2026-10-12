import { timeAgo } from '@/lib/format'
import { relayCheckHasScore, relayReportPath } from '@/lib/relayUi'

export function RelayTrend({ checks }: { checks: any[] }) {
  const done = checks.filter(relayCheckHasScore).slice(0, 24).reverse()
  return <div className="space-y-4">
    {done.length > 0 && <div className="flex h-44 items-end gap-1 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3" role="img" aria-label={`最近 ${done.length} 次有效检测的协议质量分；详细数值见下方记录`}>
      {done.map((check) => <div key={check.id} className="group relative min-w-1 max-w-12 flex-1 rounded-t bg-[var(--accent)]" style={{ height: `${Math.max(3, check.score)}%` }} title={`${check.score.toFixed(0)} 分 · ${new Date(check.finishedAt || check.createdAt).toLocaleString('zh-CN')}`}><span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded bg-[var(--bg)] px-1.5 py-0.5 text-[10px] group-hover:block">{check.score.toFixed(0)}</span></div>)}
    </div>}
    {!checks.length ? <p className="text-sm text-[var(--muted)]">还没有检测记录。完成认领和审核、配置 Key 后即可开始。</p> : <>
      <p className="text-xs text-[var(--muted)]">协议质量分只说明本次已测表现，不代表模型真伪概率。错误或证据不足的记录不进入趋势。</p>
      <ul className="relay-history">{checks.map((check) => {
        const path = relayReportPath(check)
        const status = relayCheckHasScore(check) ? `${check.score.toFixed(0)} 分${check.grade ? ` / ${check.grade}` : ''}` : check.status === 'error' ? '检测未完成' : check.status === 'done' ? '证据不足，暂不计分' : check.status === 'queued' ? '排队中' : '检测中'
        return <li key={check.id}><div className="relay-history-heading"><strong>{check.source === 'scheduled' ? '定时检测' : '手动检测'} · {check.model}</strong><span>{status}</span></div><div className="relay-history-meta"><time dateTime={check.createdAt} title={new Date(check.createdAt).toLocaleString('zh-CN')}>{timeAgo(check.createdAt)}</time>{path && <a href={path} className="text-[var(--accent)]">{['queued', 'running'].includes(check.status) ? '查看任务进度' : '查看检测报告'} →</a>}</div>{(check.error || check.summary) && <p className="relay-history-note">{check.error || check.summary}</p>}</li>
      })}</ul>
    </>}
  </div>
}
