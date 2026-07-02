import { describe, it, expect } from 'vitest'
import { selectModel, rankDataDrivenRoute } from '@/lib/route'

describe('selectModel — 任务级路由选主模型 + fallback', () => {
  it('优先 strategies[mode][0]', () => {
    const r = selectModel(
      { strategies: { cheap: ['m-cheap', 'm-2'] } },
      { cloud: ['m-cloud'] },
      'cheap',
      'm-default',
    )
    expect(r.model).toBe('m-cheap')
    expect(r.mode).toBe('cheap')
  })

  it('无 strategies 回退 cloud[0]', () => {
    const r = selectModel({}, { cloud: ['m-cloud'] }, 'balanced', 'm-default')
    expect(r.model).toBe('m-cloud')
  })

  it('全空回退 fallbackDefault + 默认 balanced', () => {
    const r = selectModel(null, null, undefined, 'm-default')
    expect(r.model).toBe('m-default')
    expect(r.mode).toBe('balanced')
  })

  it('mode 缺省时用 routePolicy.default', () => {
    const r = selectModel(
      { default: 'quality', strategies: { quality: ['m-q'] } },
      null,
      undefined,
      'm-default',
    )
    expect(r.mode).toBe('quality')
    expect(r.model).toBe('m-q')
  })

  it('fallbacks 去重且排除 primary', () => {
    const r = selectModel(
      { strategies: { cheap: ['m1'], fallback: ['m2', 'm1'] } },
      { cloud: ['m2', 'm3'] },
      'cheap',
      'm3',
    )
    expect(r.model).toBe('m1')
    expect(r.fallbacks).toEqual(['m2', 'm3'])
  })

  it('dataDriven[mode] 优先于作者手填 strategies(#15 数据改变产品动作)', () => {
    const rp = {
      strategies: { cheap: ['author-model'] },
      dataDriven: { cheap: ['data-model', 'data-2'] },
    }
    const r = selectModel(rp, { cloud: ['c'] }, 'cheap', 'def')
    expect(r.model).toBe('data-model') // 真实回流赢过手填
    expect(r.fallbacks).toContain('data-2')
    expect(r.fallbacks).not.toContain('data-model') // primary 不重复进 fallback
  })

  it('无 dataDriven 时回退作者 strategies', () => {
    const r = selectModel({ strategies: { cheap: ['author-model'] } }, null, 'cheap', 'def')
    expect(r.model).toBe('author-model')
  })
})

describe('rankDataDrivenRoute — 由兼容聚合排数据驱动路由', () => {
  const models = [
    { modelName: 'glm-4', successRate: 0.9, avgLatencyMs: 500, formatRate: 0.9, lowSample: false },
    { modelName: 'deepseek-chat', successRate: 0.8, avgLatencyMs: 900, formatRate: 0.8, lowSample: false },
    { modelName: 'qwen-plus', successRate: 0.95, avgLatencyMs: 300, formatRate: 0.95, lowSample: false },
    { modelName: 'flaky', successRate: 0.3, avgLatencyMs: 100, formatRate: 0.3, lowSample: false }, // 成功率低→排除
    { modelName: 'newbie', successRate: 1, avgLatencyMs: 50, formatRate: 1, lowSample: true }, // 样本不足→排除
  ]

  it('cheap 按成本代理升序，排除低成功率/低样本', () => {
    const r = rankDataDrivenRoute(models)
    // 成本: deepseek(0.003) < qwen(0.016) < glm-4(0.1)
    expect(r.cheap).toEqual(['deepseek-chat', 'qwen-plus', 'glm-4'])
    expect(r.cheap).not.toContain('flaky')
    expect(r.cheap).not.toContain('newbie')
  })

  it('fast 按延迟升序', () => {
    const r = rankDataDrivenRoute(models)
    expect(r.fast).toEqual(['qwen-plus', 'glm-4', 'deepseek-chat'])
  })

  it('quality 综合分最高在前', () => {
    const r = rankDataDrivenRoute(models)
    expect(r.quality[0]).toBe('qwen-plus')
  })

  it('无达标模型 → 三维皆空(保留作者手填)', () => {
    const r = rankDataDrivenRoute([
      { modelName: 'x', successRate: 0.2, avgLatencyMs: 100, formatRate: 0.2, lowSample: false },
    ])
    expect(r.cheap).toEqual([])
  })
})
