import Link from 'next/link'
import { SkillStatusTags } from './Tag'
import { formatLatency, formatNumber, formatPercent } from '@/lib/format'

// 可信分沿用 skillRank 字段，前台不再暴露旧名。
function rankColor(rank?: number | null) {
  const r = rank || 0
  if (r >= 85) return 'var(--accent-2)'
  if (r >= 70) return 'var(--accent)'
  if (r >= 50) return 'var(--warn)'
  return 'var(--faint)'
}

export function SkillCard({ skill }: { skill: any }) {
  const cat = typeof skill.category === 'object' ? skill.category : null
  const author = typeof skill.author === 'object' ? skill.author : null
  const passport = skill.passport
  const trustedCompatibleRunCount =
    skill.trustedCompatibleRunCount ?? passport?.trustedCompatibleRunCount ?? 0
  return (
    <Link
      href={`/skills/${skill.slug}`}
      className="card group flex flex-col gap-3 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--accent)] hover:shadow-[var(--shadow)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold transition-colors group-hover:text-[var(--accent)]">
            {skill.title}
          </h3>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--muted)]">
            {skill.description}
          </p>
          {skill.isEssential && skill.essentialReason && (
            <p className="mt-2 line-clamp-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-emerald-100">
              为什么先跑：{skill.essentialReason}
            </p>
          )}
        </div>
        <div
          className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl border"
          style={{
            borderColor: rankColor(skill.skillRank),
            color: rankColor(skill.skillRank),
          }}
          title="可信分"
        >
          <span className="text-base font-bold leading-none">
            {Math.round(skill.skillRank || 0)}
          </span>
          <span className="mt-0.5 text-[9px] tracking-wider text-[var(--faint)]">
            信任
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
        {cat && (
          <span className="inline-flex items-center gap-1">
            {cat.icon} {cat.name}
          </span>
        )}
        {author && (
          <span className="text-[var(--faint)]">· {author.username}</span>
        )}
        <SkillStatusTags skill={skill} />
      </div>

      <div className="grid grid-cols-4 gap-2 border-t border-[var(--border)] pt-3 text-center text-[11px]">
        <Metric
          label="Passport"
          value={
            passport ? String(Math.round(passport.trustScore || 0)) : '待生成'
          }
        />
        <Metric label="成功率" value={formatPercent(skill.successRate)} />
        <Metric label="耗时" value={formatLatency(skill.avgLatencyMs)} />
        <Metric label="可信兼容" value={formatNumber(trustedCompatibleRunCount)} />
      </div>
    </Link>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-semibold text-[var(--text)]">{value}</div>
      <div className="mt-0.5 text-[var(--faint)]">{label}</div>
    </div>
  )
}
