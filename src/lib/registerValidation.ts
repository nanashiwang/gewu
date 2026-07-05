const emailPattern =
  /^(?!.*\.\.)[\w!#$%&'*+/=?^`{|}~-](?:[\w!#$%&'*+/=?^`{|}~.-]*[\w!#$%&'*+/=?^`{|}~-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i

export const registerPasswordMinLength = 8
export const registerUsernameMinLength = 2
export const registerUsernameMaxLength = 40

export function validateRegisterInput({
  email,
  emailRequired,
  password,
  username,
}: {
  email: string
  emailRequired: boolean
  password: string
  username: string
}): string | null {
  if (!username) return '请填写用户名'
  if (username.length < registerUsernameMinLength) return `用户名至少 ${registerUsernameMinLength} 个字符`
  if (username.length > registerUsernameMaxLength) return `用户名不能超过 ${registerUsernameMaxLength} 个字符`
  if (emailRequired && !email) return '请填写邮箱'
  if (email && !emailPattern.test(email)) return '邮箱格式不正确，请检查后重试'
  if (!password) return '请填写密码'
  if (password.length < registerPasswordMinLength) return `密码至少 ${registerPasswordMinLength} 位`
  return null
}

function collectErrorText(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  const visit = (value: unknown) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    for (const key of ['message', 'detail', 'constraint', 'code', 'path', 'field']) {
      if (typeof record[key] === 'string') parts.push(record[key] as string)
    }
    const errors = record.errors ?? (record.data as Record<string, unknown> | undefined)?.errors
    if (Array.isArray(errors)) errors.forEach(visit)
    visit(record.cause)
  }
  visit(error)
  return parts.join(' ').toLowerCase()
}

export function registerCreateErrorMessage(error: unknown): string {
  const text = collectErrorText(error)
  if (!text) return '注册失败，请稍后重试'
  if (text.includes('username') || text.includes('用户名')) return '用户名已被占用，请换一个'
  if (text.includes('email') || text.includes('邮箱')) return '邮箱已被注册，请直接登录或换一个邮箱'
  if (text.includes('password') || text.includes('密码')) return `密码格式不正确，请至少输入 ${registerPasswordMinLength} 位`
  if (text.includes('duplicate key') || text.includes('23505') || text.includes('unique')) {
    return '用户名或邮箱已被注册，请换一个后重试'
  }
  if (text.includes('validation')) return '注册信息格式不正确，请检查后重试'
  return '注册失败，请稍后重试'
}
