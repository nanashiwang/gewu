import type { NewApiUsageSource, UserUsageDriftResult } from '@/lib/newapiReconcile'

export const DRIFT_REPORT_SCHEMA = 'gewu.newapi.user_drift.v1'
export const DRIFT_REMEDIATION_SCHEMA = 'gewu.newapi.user_drift_remediation.v1'

export interface DriftReportRow extends UserUsageDriftResult {
  schema: typeof DRIFT_REPORT_SCHEMA
  monthStartISO: string
  generatedAt: string
  usageSource: NewApiUsageSource
}

export interface DriftRemediationStep {
  schema: typeof DRIFT_REMEDIATION_SCHEMA
  monthStartISO: string
  userId: string
  action: UserUsageDriftResult['action']
  driftCents: number
  absDriftCents: number
  suggestedLocalCreditDelta: number
  idempotencyKey: string
  checklist: string[]
}

function finiteNumber(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`漂移报告字段 ${field} 必须是有效数字`)
  return n
}

function safeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

function monthKey(monthStartISO: string): string {
  const d = new Date(monthStartISO)
  if (!Number.isFinite(d.getTime())) throw new Error('漂移报告 monthStartISO 不是有效时间')
  return d.toISOString().slice(0, 7)
}

export function parseUserUsageDriftJsonl(text: string): DriftReportRow[] {
  const rows: DriftReportRow[] = []
  const seen = new Set<string>()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: any
    try {
      row = JSON.parse(trimmed)
    } catch {
      throw new Error(`漂移报告第 ${index + 1} 行不是合法 JSON`)
    }
    if (row.schema !== DRIFT_REPORT_SCHEMA) throw new Error(`漂移报告第 ${index + 1} 行 schema 不匹配`)
    if (!row.userId || typeof row.userId !== 'string') throw new Error(`漂移报告第 ${index + 1} 行缺少 userId`)
    if (!['newapi', 'local'].includes(row.usageSource)) throw new Error(`漂移报告第 ${index + 1} 行 usageSource 非法`)
    if (!['matched', 'newapi_gt_local', 'local_gt_newapi'].includes(row.direction)) {
      throw new Error(`漂移报告第 ${index + 1} 行 direction 非法`)
    }
    if (!['none', 'manual_backfill_local_or_refund_gateway', 'manual_refund_local_or_fix_gateway_undercharge'].includes(row.action)) {
      throw new Error(`漂移报告第 ${index + 1} 行 action 非法`)
    }
    const driftCents = Math.round(finiteNumber(row.driftCents, 'driftCents'))
    const absDriftCents = Math.round(finiteNumber(row.absDriftCents, 'absDriftCents'))
    if (absDriftCents !== Math.abs(driftCents)) throw new Error(`漂移报告第 ${index + 1} 行 absDriftCents 与 driftCents 不一致`)
    const key = `${monthKey(row.monthStartISO)}:${row.userId}`
    if (seen.has(key)) throw new Error(`漂移报告包含重复用户行 ${row.userId}，禁止生成可能双补/双退的处理计划`)
    seen.add(key)
    const expectedDirection = driftCents > 0 ? 'newapi_gt_local' : driftCents < 0 ? 'local_gt_newapi' : 'matched'
    if (row.direction !== expectedDirection) throw new Error(`漂移报告第 ${index + 1} 行 direction 与 driftCents 不一致`)
    const ok = row.ok === true
    const expectedAction = ok
      ? 'none'
      : driftCents > 0
        ? 'manual_backfill_local_or_refund_gateway'
        : driftCents < 0
          ? 'manual_refund_local_or_fix_gateway_undercharge'
          : 'none'
    if (row.action !== expectedAction) throw new Error(`漂移报告第 ${index + 1} 行 action 与 drift/ok 不一致`)
    rows.push({
      ...(row as DriftReportRow),
      newapiUsageCents: Math.round(finiteNumber(row.newapiUsageCents, 'newapiUsageCents')),
      localConsumeCents: Math.round(finiteNumber(row.localConsumeCents, 'localConsumeCents')),
      driftCents,
      absDriftCents,
      toleranceCents: Math.round(finiteNumber(row.toleranceCents, 'toleranceCents')),
      ok,
    })
  }
  return rows
}

export function buildDriftRemediationPlan(rows: DriftReportRow[]): DriftRemediationStep[] {
  return rows
    .filter((row) => row.action !== 'none')
    .map((row) => {
      const key = `newapi-drift:${monthKey(row.monthStartISO)}:${safeKeyPart(row.userId)}:${row.direction}:${row.absDriftCents}`
      const suggestedLocalCreditDelta =
        row.action === 'manual_backfill_local_or_refund_gateway'
          ? -row.absDriftCents
          : row.action === 'manual_refund_local_or_fix_gateway_undercharge'
            ? row.absDriftCents
            : 0
      const checklist =
        row.action === 'manual_backfill_local_or_refund_gateway'
          ? [
              '本计划只读生成，未修改数据库或 New API 网关',
              '先确认 New API 子令牌是否误扣、重复扣或已在网关侧退款',
              '若是网关误扣：先在 New API 侧退款/归零，不补本地 consume 流水',
              `若确认本地漏扣：人工补一条 consume 流水 ${suggestedLocalCreditDelta} credit，幂等键 ${key}`,
              '处理完成后重跑 npm run worker:reconcile-newapi dry-run',
            ]
          : [
              '本计划只读生成，未修改数据库或 New API 网关',
              '先确认本地是否重复扣费，或 New API 是否少扣/漏扣/刻度配置错误',
              '若是本地多扣：人工补一条 refund 流水 +' + row.absDriftCents + ` credit，幂等键 ${key}`,
              '若是网关少扣：先修子令牌/分组/刻度，再重跑校准与对账',
              '处理完成后重跑 npm run worker:reconcile-newapi dry-run',
            ]
      return {
        schema: DRIFT_REMEDIATION_SCHEMA,
        monthStartISO: row.monthStartISO,
        userId: row.userId,
        action: row.action,
        driftCents: row.driftCents,
        absDriftCents: row.absDriftCents,
        suggestedLocalCreditDelta,
        idempotencyKey: key,
        checklist,
      }
    })
}

export function formatDriftRemediationPlanJsonl(steps: DriftRemediationStep[]): string {
  return steps.map((step) => JSON.stringify(step)).join('\n')
}
