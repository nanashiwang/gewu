import { describe, it, expect } from 'vitest'
import { classifyError } from '@/lib/errorTaxonomy'

describe('classifyError — 运行错误受控分类(6m 负知识)', () => {
  it('成功+格式有效 → 无错(undefined)', () => {
    expect(
      classifyError({ hasResult: true, formatValid: true, outputSchemaPresent: true, text: '{"a":1}' }),
    ).toBeUndefined()
  })

  it('无 schema 的成功输出 → 无错', () => {
    expect(
      classifyError({ hasResult: true, formatValid: false, outputSchemaPresent: false, text: 'hello' }),
    ).toBeUndefined()
  })

  it('调用失败：超时/限流/鉴权/5xx/4xx/网络/未知', () => {
    const f = (lastError: string) => classifyError({ hasResult: false, lastError, formatValid: false, outputSchemaPresent: false })
    expect(f('Request timed out')).toBe('timeout')
    expect(f('429 too many requests')).toBe('rate_limit')
    expect(f('401 unauthorized: invalid api key')).toBe('auth')
    expect(f('500 internal server error')).toBe('http_5xx')
    expect(f('400 bad request')).toBe('http_4xx')
    expect(f('fetch failed ECONNREFUSED')).toBe('network')
    expect(f('something weird')).toBe('unknown_infra')
  })

  it('能力层：空输出 / 非JSON / 字段漂移', () => {
    expect(classifyError({ hasResult: true, formatValid: false, outputSchemaPresent: true, text: '   ' })).toBe('empty_output')
    expect(classifyError({ hasResult: true, formatValid: false, outputSchemaPresent: true, text: '抱歉我无法完成' })).toBe('json_invalid')
    expect(classifyError({ hasResult: true, formatValid: false, outputSchemaPresent: true, text: '{"wrong":1}' })).toBe('format_drift')
  })

  it('鉴权优先于纯数字 4xx 匹配', () => {
    expect(
      classifyError({ hasResult: false, lastError: '403 forbidden', formatValid: false, outputSchemaPresent: false }),
    ).toBe('auth')
  })
})
