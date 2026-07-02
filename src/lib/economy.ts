import type { Payload } from 'payload'
import { sql } from 'drizzle-orm'

// 变现经济：配置读取 + 兑换池/用户额度核算。credit 与「分」1:1（1 credit=¥0.01=1 分）。

// 兑换全局咨询锁 key（pg_advisory_xact_lock）：串行化所有兑换关键区，随事务提交/回滚自动释放。
// 兑换低频，全局串行可接受，换来池超支/术值透支的并发绝对安全。
export const EXCHANGE_LOCK_KEY = 4771001

// 在指定事务内获取兑换咨询锁（阻塞至独占）。之后事务内的复核读(READ COMMITTED)即可见此前已提交的兑换。
export async function acquireExchangeLock(payload: Payload, transactionID: string | number): Promise<void> {
  const session = (payload.db as any).sessions?.[transactionID]
  if (!session?.db) throw new Error('事务会话不可用，无法加兑换锁')
  // key 为硬编码常量，无注入风险，用 raw 避免参数类型绑定问题
  await (payload.db as any).execute({ db: session.db, raw: `SELECT pg_advisory_xact_lock(${EXCHANGE_LOCK_KEY})` })
}

export interface EconomyConfig {
  exchangeEnabled: boolean
  freeCreditOnRegister: number
  alpha: number
  monthlyRealizedMarginCents: number
  pointsPerCredit: number
  minCreditPerTx: number
  perTxMaxCredit: number
  perUserDailyMaxCredit: number
  perUserMonthlyMaxCredit: number
}

const DEFAULTS: EconomyConfig = {
  exchangeEnabled: false,
  freeCreditOnRegister: 0,
  alpha: 0.3,
  monthlyRealizedMarginCents: 0,
  pointsPerCredit: 10,
  minCreditPerTx: 10,
  perTxMaxCredit: 500,
  perUserDailyMaxCredit: 1000,
  perUserMonthlyMaxCredit: 5000,
}

export async function getEconomyConfig(payload: Payload): Promise<EconomyConfig> {
  const g = (await payload.findGlobal({ slug: 'economy-settings' }).catch(() => null)) as any
  if (!g) return { ...DEFAULTS }
  const num = (v: any, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    exchangeEnabled: !!g.exchangeEnabled,
    // 赠送额度加硬上限（防管理员误设 99999 配合批量注册放血）：不超过单次兑换上限
    freeCreditOnRegister: Math.min(
      Math.max(1, num(g.perTxMaxCredit, DEFAULTS.perTxMaxCredit)),
      Math.max(0, Math.floor(num(g.freeCreditOnRegister, 0))),
    ),
    alpha: Math.min(1, Math.max(0, num(g.alpha, DEFAULTS.alpha))), // clamp[0,1]：防巨大 α 架空"永不亏 margin"红线
    monthlyRealizedMarginCents: Math.max(0, num(g.monthlyRealizedMarginCents, 0)),
    pointsPerCredit: Math.max(1, num(g.pointsPerCredit, DEFAULTS.pointsPerCredit)),
    minCreditPerTx: Math.max(1, num(g.minCreditPerTx, DEFAULTS.minCreditPerTx)),
    perTxMaxCredit: Math.max(1, num(g.perTxMaxCredit, DEFAULTS.perTxMaxCredit)),
    perUserDailyMaxCredit: Math.max(0, num(g.perUserDailyMaxCredit, DEFAULTS.perUserDailyMaxCredit)),
    perUserMonthlyMaxCredit: Math.max(0, num(g.perUserMonthlyMaxCredit, DEFAULTS.perUserMonthlyMaxCredit)),
  }
}

export function monthStartISO(now = new Date()): string {
  const d = new Date(now)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function dayStartISO(now = new Date()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// 兑换池总额（credit）= floor(α × 当月已实现毛利分)
export function exchangePoolTotal(cfg: EconomyConfig): number {
  return Math.max(0, Math.floor(cfg.alpha * cfg.monthlyRealizedMarginCents))
}

// 汇总 credit-logs.amount（分页累加；Payload 无原生 SUM）。可按 type / 时间窗 / 用户过滤。
export async function sumCreditAmount(
  payload: Payload,
  opts: { type?: string; sinceISO?: string; userId?: string; req?: any },
): Promise<number> {
  const and: any[] = []
  if (opts.type) and.push({ type: { equals: opts.type } })
  if (opts.sinceISO) and.push({ createdAt: { greater_than_equal: opts.sinceISO } })
  if (opts.userId) and.push({ user: { equals: opts.userId } })
  const where: any = and.length ? { and } : {}
  const tx = opts.req ? { req: opts.req } : {}

  let sum = 0
  let page = 1
  for (;;) {
    const res = await payload.find({
      collection: 'credit-logs',
      where,
      limit: 500,
      page,
      depth: 0,
      overrideAccess: true,
      sort: 'id',
      ...tx,
    })
    for (const d of res.docs as any[]) sum += d.amount || 0
    if (!res.hasNextPage) break
    page++
  }
  return sum
}

// 兑换池剩余（credit）= 池总额 − 当月已兑出（type=exchange 的正额之和）
export async function exchangePoolRemaining(
  payload: Payload,
  cfg: EconomyConfig,
  req?: any,
): Promise<number> {
  const total = exchangePoolTotal(cfg)
  const used = await sumCreditAmount(payload, { type: 'exchange', sinceISO: monthStartISO(), req })
  return Math.max(0, total - used)
}

// 用户当日/当月已兑出 credit
export async function userExchangedInWindow(
  payload: Payload,
  userId: string,
  sinceISO: string,
  req?: any,
): Promise<number> {
  return sumCreditAmount(payload, { type: 'exchange', sinceISO, userId, req })
}
