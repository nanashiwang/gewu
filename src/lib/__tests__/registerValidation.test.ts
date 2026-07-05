import { describe, expect, it } from 'vitest'
import { registerCreateErrorMessage, validateRegisterInput } from '@/lib/registerValidation'

describe('registerValidation — 注册错误提示', () => {
  it('提示用户名问题', () => {
    expect(validateRegisterInput({ username: '', email: '', emailRequired: false, password: 'password123' })).toBe(
      '请填写用户名',
    )
    expect(validateRegisterInput({ username: 'a', email: '', emailRequired: false, password: 'password123' })).toBe(
      '用户名至少 2 个字符',
    )
  })

  it('提示邮箱问题', () => {
    expect(
      validateRegisterInput({ username: 'alice', email: '', emailRequired: true, password: 'password123' }),
    ).toBe('请填写邮箱')
    expect(
      validateRegisterInput({ username: 'alice', email: 'bad-email', emailRequired: false, password: 'password123' }),
    ).toBe('邮箱格式不正确，请检查后重试')
  })

  it('提示密码问题', () => {
    expect(validateRegisterInput({ username: 'alice', email: '', emailRequired: false, password: '' })).toBe('请填写密码')
    expect(validateRegisterInput({ username: 'alice', email: '', emailRequired: false, password: '1234567' })).toBe(
      '密码至少 8 位',
    )
  })

  it('翻译数据库唯一约束错误', () => {
    expect(registerCreateErrorMessage({ message: 'duplicate key value violates users_username_idx' })).toBe(
      '用户名已被占用，请换一个',
    )
    expect(registerCreateErrorMessage({ message: 'duplicate key value violates users_email_idx' })).toBe(
      '邮箱已被注册，请直接登录或换一个邮箱',
    )
  })

  it('未知错误保留兜底但不再要求用户检查所有信息', () => {
    expect(registerCreateErrorMessage({ message: 'connection reset' })).toBe('注册失败，请稍后重试')
  })
})
