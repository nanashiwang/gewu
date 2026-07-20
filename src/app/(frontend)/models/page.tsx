import { getPayloadClient } from '@/lib/payload'
import { aggregateModelsGlobal } from '@/lib/compat'
import { rankModels, type ModelRankRow } from '@/lib/modelrank'
import { comparePriceTransparency } from '@/lib/priceTransparency'
import { MODEL_PRICES } from '@/lib/constants'
import { formatLatency, formatPercent } from '@/lib/format'
import { buildModelProfileWhere, isPublicModelProfile } from '@/lib/modelProfilePublic'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '模型中立榜 · 格物',
  description:
    '基于真实运行数据的中立模型评测：成功率、延迟、官方报价与成本效率。排名不含平台收益因素。',
}

const SORTS = [
  { key: 'value', label: '成本效率' },
  { key: 'quality', label: '质量' },
  { key: 'latency', label: '速度' },
  { key: 'price', label: '价格' },
] as const

function driftLabel(history: any[]): string | null {
  if (!Array.isArray(history) || history.length < 2) return null
  const prev = history[history.length - 2]
  const last = history[history.length - 1]
  const from = Number(prev?.successRate)
  const to = Number(last?.successRate)
  if (!Number.isFinite(from) || !Number.isFinite(to))
    return `${history.length}点漂移`
  const delta = Math.round((to - from) * 100)
  return `${history.length}点漂移 · 成功率${delta >= 0 ? '+' : ''}${delta}%`
}

type SP = Record<string, string | undefined>

function buildHref(base: SP, patch: SP): string {
  const merged: SP = { ...base, ...patch }
  const qs = Object.entries(merged)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
    .join('&')
  return qs ? `/models?${qs}` : '/models'
}

function paramsFromSearch(sp: SP) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    if (value) params.set(key, value)
  }
  return params
}

function modelProfileApiHref(modelName: string, profile?: any) {
  const params = new URLSearchParams({ modelName })
  if (profile?.modelVersion) params.set('modelVersion', String(profile.modelVersion))
  return `/v1/model-profiles?${params.toString()}`
}

function modelLinkedHref(base: '/failures' | '/v1/adapters', modelName: string, profile?: any) {
  const params = new URLSearchParams({ modelName })
  if (profile?.modelVersion) params.set('modelVersion', String(profile.modelVersion))
  return `${base}?${params.toString()}`
}

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const sortBy = (SORTS.find((s) => s.key === sp.sort)?.key || 'value') as
    | 'value'
    | 'quality'
    | 'latency'
    | 'price'

  const profileWhere = buildModelProfileWhere(paramsFromSearch(sp))
  const filtersActive = Boolean(sp.modelName || sp.modelVersion || sp.provider || sp.status)

  const payload = await getPayloadClient()
  const [stats, priceRes, profileRes] = await Promise.all([
    aggregateModelsGlobal(payload, { publicSkillOnly: true }),
    payload.find({
      collection: 'model-price-snapshots',
      limit: 500,
      depth: 0,
      overrideAccess: true,
    }),
    payload.find({
      collection: 'model-profiles' as any,
      where: profileWhere,
      limit: 500,
      depth: 0,
      overrideAccess: true,
      sort: '-lastObservedAt',
    }),
  ])
  // 官方价：同模型取最近一条快照
  const priceByModel = new Map<string, any>()
  for (const p of priceRes.docs as any[]) {
    const prev = priceByModel.get(p.model)
    if (
      !prev ||
      new Date(p.capturedAt || p.updatedAt || 0) >
        new Date(prev.capturedAt || prev.updatedAt || 0)
    ) {
      priceByModel.set(p.model, p)
    }
  }
  const publicProfiles = (profileRes.docs as any[]).filter(isPublicModelProfile)
  const profileByModel = new Map<string, any>()
  for (const p of publicProfiles) {
    const key = p.modelName
    if (!key || profileByModel.has(key)) continue
    profileByModel.set(key, p)
  }
  const allowedModels = new Set(publicProfiles.map((p) => p.modelName).filter(Boolean))
  const rows: ModelRankRow[] = stats
    .filter((s) => {
      if (sp.modelName && s.model !== sp.modelName) return false
      if ((sp.provider || sp.status) && !allowedModels.has(s.model))
        return false
      return true
    })
    .map((s) => {
      const price = priceByModel.get(s.model)
      return {
        model: s.model,
        successRate: s.successRate,
        formatRate: s.formatRate,
        avgLatencyMs: s.avgLatencyMs,
        samples: s.samples,
        effectiveSamples: s.effectiveSamples,
        sourceSummary: s.sourceSummary,
        inputBucketSummary: s.inputBucketSummary,
        taskProfileSummary: s.taskProfileSummary,
        skillProfileSummary: s.skillProfileSummary,
        officialInputPrice: price?.inputPrice,
        officialOutputPrice: price?.outputPrice,
      }
    })
  const ranked = rankModels(rows, sortBy)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">模型中立榜</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          基于全站真实运行的实测事实（成功率/延迟）+ 官方公开报价。
          <b className="text-[var(--text)]">排名不含任何平台收益因素</b>
          （CI 断言强制 · 时间衰减 30 天 · 来源分级权重，近期真实回流主导）。
        </p>
      </div>

      <section className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-xs md:grid-cols-4">
        <div>
          <div className="font-semibold text-[var(--text)]">1. 先看版本</div>
          <p className="mt-1 text-[var(--muted)]">
            同名模型不同版本可能表现不同，优先用明确 modelVersion 复核。
          </p>
        </div>
        <div>
          <div className="font-semibold text-[var(--text)]">2. 看有效样本</div>
          <p className="mt-1 text-[var(--muted)]">
            样本少只建议试跑；有效样本和来源权重比普通调用量更重要。
          </p>
        </div>
        <div>
          <div className="font-semibold text-[var(--text)]">3. 看漂移/回归</div>
          <p className="mt-1 text-[var(--muted)]">
            有回归告警时先锁版本、换模型，或等待 Adapter 修复。
          </p>
        </div>
        <div>
          <div className="font-semibold text-[var(--text)]">4. 查失败库</div>
          <p className="mt-1 text-[var(--muted)]">
            对应模型可直达失败库和 Adapter，判断是否已有修复经验。
          </p>
        </div>
      </section>

      <div className="flex gap-1 text-sm">
        {SORTS.map((s) => (
          <a
            key={s.key}
            href={buildHref(sp, { sort: s.key })}
            className={`rounded-md px-3 py-1 ${
              sortBy === s.key
                ? 'bg-[var(--panel-2)] text-[var(--text)]'
                : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            {s.label}
          </a>
        ))}
      </div>

      <form
        action="/models"
        className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4"
      >
        <input type="hidden" name="sort" value={sortBy} />
        <div className="grid gap-3 md:grid-cols-5">
          <label className="space-y-1 text-xs text-[var(--muted)]">
            模型名
            <input
              name="modelName"
              defaultValue={sp.modelName || ''}
              placeholder="gpt-4.1-mini"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            模型版本
            <input
              name="modelVersion"
              defaultValue={sp.modelVersion || ''}
              placeholder="2026-07-01 / latest"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            Provider
            <input
              name="provider"
              defaultValue={sp.provider || ''}
              placeholder="openai / qwen"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            />
          </label>
          <label className="space-y-1 text-xs text-[var(--muted)]">
            画像状态
            <select
              name="status"
              defaultValue={sp.status || ''}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text)]"
            >
              <option value="">全部</option>
              <option value="observed">观测中</option>
              <option value="verified">已验证</option>
              <option value="stale">证据过期</option>
              <option value="deprecated">已废弃</option>
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-black"
            >
              筛选画像
            </button>
            {filtersActive ? (
              <a
                href={buildHref(sp, {
                  modelName: '',
                  modelVersion: '',
                  provider: '',
                  status: '',
                })}
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)] hover:text-[var(--text)]"
              >
                清空
              </a>
            ) : null}
          </div>
        </div>
        <p className="mt-2 text-xs text-[var(--faint)]">
          筛选只影响模型画像与排名展示，不引入平台收益字段。
        </p>
      </form>

      {ranked.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)]">
          还没有足够的运行数据。跑一些 Skill 后这里会出现模型实测榜。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--panel)] text-left text-xs text-[var(--muted)]">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">模型</th>
                <th className="px-3 py-2 text-right font-medium">质量</th>
                <th className="px-3 py-2 text-right font-medium">成功率</th>
                <th className="px-3 py-2 text-right font-medium">延迟</th>
                <th className="px-3 py-2 text-right font-medium">官方价/1k</th>
                <th className="px-3 py-2 text-right font-medium">
                  平台估算/1k
                </th>
                <th className="px-3 py-2 text-right font-medium">成本效率</th>
                <th className="px-3 py-2 font-medium">画像状态</th>
                <th className="px-3 py-2 text-right font-medium">样本</th>
                <th className="px-3 py-2 font-medium">来源权重</th>
                <th className="px-3 py-2 font-medium">输入档</th>
                <th className="px-3 py-2 font-medium">任务画像</th>
                <th className="px-3 py-2 font-medium">行动</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((m, i) => {
                const platform = MODEL_PRICES[m.model]
                const profile = profileByModel.get(m.model)
                const alerts = Array.isArray(profile?.regressionAlerts)
                  ? profile.regressionAlerts
                  : []
                const drift = driftLabel(profile?.driftHistory)
                const critical = alerts.some(
                  (a: any) => a.severity === 'critical',
                )
                const price = comparePriceTransparency({
                  official: {
                    input: m.officialInputPrice,
                    output: m.officialOutputPrice,
                  },
                  platform: platform
                    ? { input: platform.in, output: platform.out }
                    : null,
                })
                return (
                  <tr
                    key={m.model}
                    className="border-b border-[var(--border)] last:border-0"
                  >
                    <td className="px-3 py-2.5 text-[var(--muted)]">
                      {m.lowSample ? '—' : i + 1}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{m.model}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-[var(--accent)]">
                      {m.lowSample ? '积累中' : m.qualityScore}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {m.lowSample
                        ? `已${m.samples}次`
                        : formatPercent(m.successRate)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {formatLatency(m.avgLatencyMs)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {price.officialPrice != null
                        ? `¥${price.officialPrice}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {price.platformPrice != null ? (
                        <span
                          className={
                            price.byokCheaper
                              ? 'font-semibold text-red-500'
                              : ''
                          }
                        >
                          ¥{price.platformPrice}
                          {price.byokCheaper && (
                            <span
                              className="ml-1 text-[10px]"
                              title="官方价低于平台估算价，适合绑定自有模型网关"
                            >
                              官方价更低
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[var(--muted)]">待校准</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--accent-2)]">
                      {m.valueScore != null && !m.lowSample
                        ? m.valueScore
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {alerts.length > 0 ? (
                        <span
                          className={
                            critical ? 'text-red-400' : 'text-amber-300'
                          }
                        >
                          {critical ? '严重回归' : '回归告警'} ·{' '}
                          {alerts
                            .map(
                              (a: any) =>
                                `${a.metric}${Math.round(Number(a.delta || 0) * 100)}%`,
                            )
                            .join(' / ')}
                        </span>
                      ) : profile?.driftSummary?.status === 'stable' ? (
                        <span className="text-emerald-300">
                          {drift || '稳定'}
                        </span>
                      ) : profile ? (
                        <span className="text-[var(--muted)]">
                          {drift || profile.profileStatus || 'observed'}
                        </span>
                      ) : (
                        <span className="text-[var(--faint)]">待画像</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--muted)]">
                      {m.samples}
                      {m.effectiveSamples != null ? (
                        <div className="text-[10px] text-[var(--faint)]">
                          有效 {m.effectiveSamples}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                      {m.sourceSummary?.length
                        ? m.sourceSummary
                            .map(
                              (s: any) => `${s.source}×${s.weight}:${s.count}`,
                            )
                            .join(' / ')
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                      {m.inputBucketSummary?.length
                        ? m.inputBucketSummary
                            .slice(0, 2)
                            .map(
                              (b: any) =>
                                `${b.inputBucket}:${formatPercent(b.successRate)}(${b.count})`,
                            )
                            .join(' / ')
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[var(--muted)]">
                      {m.skillProfileSummary?.length
                        ? m.skillProfileSummary
                            .slice(0, 2)
                            .map((p: any) => `${p.skillSlug || p.skillId}:${p.inputBucket}/${p.errorType}:${p.count}`)
                            .join(' / ')
                        : m.taskProfileSummary?.length
                          ? m.taskProfileSummary
                              .slice(0, 2)
                              .map((p: any) => `${p.inputBucket}/${p.errorType}:${p.count}`)
                              .join(' / ')
                          : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <a
                        href={modelProfileApiHref(m.model, profile)}
                        className="text-[var(--accent)] hover:underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        画像 API
                      </a>
                      <a
                        href={modelLinkedHref('/failures', m.model, profile)}
                        className="ml-2 text-[var(--accent)] hover:underline"
                      >
                        失败库
                      </a>
                      <a
                        href={modelLinkedHref('/v1/adapters', m.model, profile)}
                        className="ml-2 text-[var(--accent)] hover:underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Adapter
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-[var(--faint)]">
        方法论：逐条报告按时间指数衰减（半衰期 30 天）×
        来源权重（verified/benchmark=1 · 社区=0.5 · 在线=0.3）加权。 质量 =
        0.7×成功率 + 0.3×格式率。成本效率 = 质量 ÷
        官方价，排名不使用平台估算价。
        平台估算价仅用于提示履约成本；若高于官方价则标记“官方价更低”，用户可绑定自有模型网关。
      </p>
    </div>
  )
}
