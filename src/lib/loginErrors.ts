export function loginErrorMessage(data: any, status?: number): string {
  const text = [
    data?.errors?.[0]?.message,
    data?.message,
    data?.error,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (status === 401 || text.includes('email or password') || text.includes('incorrect')) {
    return '账号或密码错误'
  }
  if (text.includes('locked') || text.includes('too many')) {
    return '登录失败次数过多，请稍后再试'
  }
  if (text.includes('banned') || text.includes('封禁')) {
    return '账号已被封禁'
  }
  return data?.errors?.[0]?.message || data?.message || data?.error || '登录失败'
}
