import { getPayload } from 'payload'
import config from '@payload-config'
import { loginIdentifierKind, normalizeLoginIdentifier } from '@/lib/loginIdentifier'
import { loginErrorMessage } from '@/lib/loginErrors'

function isFormLoginRequest(request: Request): boolean {
  const contentType = request.headers.get('content-type') || ''
  return contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')
}

function appendForwardedCookies(headers: Headers, sourceHeaders: Headers) {
  const cookies =
    typeof (sourceHeaders as any).getSetCookie === 'function'
      ? (sourceHeaders as any).getSetCookie()
      : sourceHeaders.get('set-cookie')
        ? [sourceHeaders.get('set-cookie') as string]
        : []
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
}

function responseWithForwardedCookies(body: string, status: number, sourceHeaders: Headers): Response {
  const headers = new Headers({ 'Content-Type': sourceHeaders.get('content-type') || 'application/json' })
  appendForwardedCookies(headers, sourceHeaders)
  return new Response(body, { status, headers })
}

function formFailure(message: string): Response {
  const params = new URLSearchParams({ error: message })
  return new Response(null, { status: 303, headers: { Location: `/login?${params.toString()}` } })
}

function formSuccess(sourceHeaders: Headers): Response {
  const headers = new Headers({ Location: '/console' })
  appendForwardedCookies(headers, sourceHeaders)
  return new Response(null, { status: 303, headers })
}

async function readLoginBody(request: Request, formMode: boolean) {
  if (formMode) {
    const form = await request.formData()
    return {
      identifier: form.get('identifier') ?? form.get('email') ?? form.get('username'),
      password: form.get('password'),
    }
  }
  return request.json()
}

// POST /v1/auth/login —— 邮箱/用户名均可登录；最终仍委托 Payload auth 生成会话 cookie。
export async function POST(request: Request) {
  const formMode = isFormLoginRequest(request)
  const fail = (message: string, status = 400) =>
    formMode ? formFailure(message) : Response.json({ error: message }, { status })

  let body: any = {}
  try {
    body = await readLoginBody(request, formMode)
  } catch {
    return fail('请求体无效', 400)
  }

  const identifier = normalizeLoginIdentifier(body.identifier ?? body.email ?? body.username)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!identifier || !password) return fail('账号和密码均为必填', 400)

  let email = identifier
  if (loginIdentifierKind(identifier) === 'username') {
    const payload = await getPayload({ config })
    const users = await payload.find({
      collection: 'users',
      where: { username: { equals: identifier } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const user = users.docs[0] as any
    if (!user?.email) return fail('账号或密码错误', 401)
    email = user.email
  }

  const origin = new URL(request.url).origin
  const loginRes = await fetch(`${origin}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const text = await loginRes.text()
  if (!loginRes.ok) {
    let data: any = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      /* ignore */
    }
    return fail(loginErrorMessage(data, loginRes.status), loginRes.status)
  }
  if (formMode) return formSuccess(loginRes.headers)
  return responseWithForwardedCookies(text, loginRes.status, loginRes.headers)
}
