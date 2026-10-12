import type { MonitorHealth } from '@/lib/monitorHealth'

function utc(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无记录'
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function MonitorHealthPanel({ health }: { health: MonitorHealth }) {
  return <section className="card space-y-4 p-5" aria-labelledby="monitor-health-title">
    <div><h2 id="monitor-health-title" className="text-lg font-semibold">运营监测健康</h2><p className="mt-2 text-sm text-[var(--muted)]">检查格物能否取得有效证据。监测凭据错误不代表站点故障；有效检测也可能发现协议或能力异常。</p></div>
    {!health.available ? <p role="status" className="text-sm text-[var(--danger)]">暂时无法读取监测状态。请核查检测服务、内部鉴权与健康记录权限，不要据此判断监测正常。</p> : !health.targets.length ? <p className="text-sm text-[var(--muted)]">尚无运营监测记录。</p> : <div className="grid gap-3 xl:grid-cols-2">{health.targets.map(target => <article key={target.target_id} className="min-w-0 space-y-3 rounded-xl border border-[var(--border)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-all font-medium">{target.target_id}</h3><span className={target.failure_kind === 'valid' ? 'text-sm text-[var(--accent)]' : 'text-sm text-[var(--danger)]'}>{target.label}</span></div>
      <p className="break-all text-xs text-[var(--muted)]">{target.protocol} · {target.model} · {target.mode}</p>
      <dl className="space-y-2 text-sm"><div className="flex flex-wrap justify-between gap-2"><dt>连续未完成</dt><dd>{target.consecutive_failures} 次</dd></div><div className="flex flex-wrap justify-between gap-2"><dt>最近采样尝试</dt><dd>{utc(target.last_attempt_at)}</dd></div><div className="flex flex-wrap justify-between gap-2"><dt>最近有效检测</dt><dd>{utc(target.last_valid_at)}</dd></div></dl>
      {target.failure_kind !== 'valid' && <p className="text-xs leading-6 text-[var(--muted)]">{target.cooling ? `冷却中，最早可重试：${utc(target.next_attempt_at)}。` : '已到可重试时间，等待原定时任务触发。'}实际执行仍以定时策略为准。{target.failure_kind === 'authentication' ? '请核查专用 Key、账号权限与对应入口；修复前不必反复提交。' : '请核查配置与报告中的错误项目。'}</p>}
      {target.last_report_id && /^[A-Za-z0-9_-]{8,64}$/.test(target.last_report_id) && <a className="text-sm text-[var(--accent)]" href={`/r/${target.last_report_id}`}>查看最近报告 →</a>}
    </article>)}</div>}
    <p className="text-xs leading-6 text-[var(--muted)]">仅管理员与审核员可见。状态最多缓存 60 秒；记录包含历史任务，不等于当前启用清单。{health.summary.history_limited && '本次回溯已达 5,000 份报告，连续失败次数可能未覆盖更早历史。'}</p>
  </section>
}
