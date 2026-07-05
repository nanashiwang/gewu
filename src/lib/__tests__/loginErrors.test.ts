import { describe, expect, it } from 'vitest'
import { loginErrorMessage } from '@/lib/loginErrors'

describe('loginErrors — 登录错误中文化', () => {
  it('把 Payload 英文账号密码错误翻译成中文', () => {
    expect(loginErrorMessage({ message: 'The email or password provided is incorrect.' }, 401)).toBe('账号或密码错误')
  })

  it('401 无论原文如何都不暴露细节', () => {
    expect(loginErrorMessage({ message: 'Unauthorized' }, 401)).toBe('账号或密码错误')
  })

  it('保留封禁语义', () => {
    expect(loginErrorMessage({ message: '账号已被封禁' }, 403)).toBe('账号已被封禁')
  })
})
