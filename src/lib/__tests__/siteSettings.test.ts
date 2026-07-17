import { describe, expect, it } from 'vitest'
import {
  getRegistrationEmailRequired,
  normalizeRegistrationEmail,
  resolveRegistrationEmail,
} from '@/lib/siteSettings'

describe('siteSettings — 注册邮箱开关', () => {
  it('后台未配置时默认不要求邮箱', async () => {
    const payload = { findGlobal: async () => ({}) }
    await expect(getRegistrationEmailRequired(payload)).resolves.toBe(false)
  })

  it('后台可开启注册邮箱必填', async () => {
    const payload = { findGlobal: async () => ({ registrationEmailRequired: true }) }
    await expect(getRegistrationEmailRequired(payload)).resolves.toBe(true)
  })

  it('邮箱规范化为小写去空格', () => {
    expect(normalizeRegistrationEmail('  USER@Example.COM  ')).toBe('user@example.com')
  })

  it('邮箱必填时空邮箱不生成账号邮箱', () => {
    expect(resolveRegistrationEmail('', true)).toBe('')
  })

  it('邮箱非必填时空邮箱生成内部占位邮箱', () => {
    expect(resolveRegistrationEmail('', false)).toMatch(/^user-[0-9a-f-]+@users\.gewu\.invalid$/)
  })
})
