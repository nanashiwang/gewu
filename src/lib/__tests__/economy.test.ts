import { describe, it, expect } from 'vitest'
import { exchangePoolTotal, monthStartISO, dayStartISO } from '@/lib/economy'

const cfg = (over: Partial<any> = {}) => ({
  exchangeEnabled: true,
  freeCreditOnRegister: 0,
  alpha: 0.3,
  monthlyRealizedMarginCents: 0,
  pointsPerCredit: 10,
  minCreditPerTx: 10,
  perTxMaxCredit: 500,
  perUserDailyMaxCredit: 1000,
  perUserMonthlyMaxCredit: 5000,
  ...over,
})

describe('exchangePoolTotal — 池 = floor(α×毛利分)，永不亏 margin', () => {
  it('正常：0.3×1000 = 300', () => {
    expect(exchangePoolTotal(cfg({ alpha: 0.3, monthlyRealizedMarginCents: 1000 }))).toBe(300)
  })
  it('向下取整', () => {
    expect(exchangePoolTotal(cfg({ alpha: 0.33, monthlyRealizedMarginCents: 1000 }))).toBe(330)
    expect(exchangePoolTotal(cfg({ alpha: 0.3, monthlyRealizedMarginCents: 999 }))).toBe(299)
  })
  it('α=0 或毛利=0 → 池空', () => {
    expect(exchangePoolTotal(cfg({ alpha: 0, monthlyRealizedMarginCents: 1000 }))).toBe(0)
    expect(exchangePoolTotal(cfg({ alpha: 0.3, monthlyRealizedMarginCents: 0 }))).toBe(0)
  })
  it('负毛利 → Math.max(0) 兜成空池（不为负）', () => {
    expect(exchangePoolTotal(cfg({ alpha: 0.3, monthlyRealizedMarginCents: -5000 }))).toBe(0)
  })
})

describe('时间窗起点（TZ 无关不变量）', () => {
  it('monthStartISO：当月 1 号本地 0 点', () => {
    const ms = new Date(monthStartISO(new Date('2026-07-15T10:30:00')))
    expect(ms.getDate()).toBe(1)
    expect(ms.getHours()).toBe(0)
    expect(ms.getMinutes()).toBe(0)
  })
  it('dayStartISO：当日本地 0 点', () => {
    const src = new Date('2026-07-15T10:30:00')
    const ds = new Date(dayStartISO(src))
    expect(ds.getDate()).toBe(src.getDate())
    expect(ds.getHours()).toBe(0)
    expect(ds.getMinutes()).toBe(0)
  })
})
