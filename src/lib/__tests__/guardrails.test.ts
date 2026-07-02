import { describe, it, expect, afterEach, vi } from 'vitest'
import { approvedPlatformModels } from '@/lib/constants'
import { creditsFromYuan } from '@/lib/credit'

describe('approvedPlatformModels — 平台代付国产白名单(6l)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('默认白名单：含国产模型、不含境外模型', () => {
    vi.stubEnv('APPROVED_PLATFORM_MODELS', '')
    const s = approvedPlatformModels()
    expect(s.has('deepseek-chat')).toBe(true)
    expect(s.has('qwen-plus')).toBe(true)
    expect(s.has('glm-4')).toBe(true)
    // 合规红线：任何境外未备案模型不得出现在平台代付默认表
    expect(s.has('claude-haiku-4-5-20251001')).toBe(false)
    expect(s.has('gpt-5.4')).toBe(false)
    expect(s.has('grok-4.3')).toBe(false)
  })

  it('env 覆盖：逗号分隔+去空格', () => {
    vi.stubEnv('APPROVED_PLATFORM_MODELS', 'deepseek-chat, glm-4 ,custom-model')
    const s = approvedPlatformModels()
    expect(s.has('custom-model')).toBe(true)
    expect(s.has('glm-4')).toBe(true)
    expect(s.has('qwen-plus')).toBe(false) // 覆盖后默认表失效
    expect(s.size).toBe(3)
  })
})

describe('creditsFromYuan — 元→credit 换算(1credit=¥0.01，防单位错位)', () => {
  it('¥1 = 100 credit', () => {
    expect(creditsFromYuan(1)).toBe(100)
  })
  it('¥0.0126 = 1.26 credit（2 位小数）', () => {
    expect(creditsFromYuan(0.0126)).toBe(1.26)
  })
  it('0/NaN/undefined → 0', () => {
    expect(creditsFromYuan(0)).toBe(0)
    expect(creditsFromYuan(NaN)).toBe(0)
    expect(creditsFromYuan(undefined as any)).toBe(0)
  })
  it('极小成本不放大不丢符号', () => {
    expect(creditsFromYuan(0.0001)).toBe(0.01)
  })
})
