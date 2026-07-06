import { getPayload } from 'payload'
import config from '@payload-config'
import { awardContribution } from '@/lib/contribution'
import { applyCredit } from '@/lib/credit'
import { getEconomyConfig } from '@/lib/economy'
import { getNewApiAdmin } from '@/lib/newapiAdmin'
import { syncNewApiQuotaToBalance } from '@/lib/newapiQuota'
import { getClientIp, hashDeviceId, hashIp } from '@/lib/clientMeta'
import { normalizeRegisterCreditAmount, registerCreditIdempotencyKey } from '@/lib/registerCredit'
import { acquireInviteCodeLock } from '@/lib/dbLocks'
import { getRegistrationEmailRequired, normalizeRegistrationEmail, resolveRegistrationEmail } from '@/lib/siteSettings'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'
import { registerCreateErrorMessage, validateRegisterInput } from '@/lib/registerValidation'

function isFormRegisterRequest(request: Request): boolean {
  const contentType = request.headers.get('content-type') || ''
  return contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')
}

async function readRegisterBody(request: Request, formMode: boolean) {
  if (formMode) {
    const form = await request.formData()
    return {
      email: form.get('email'),
      inviteCode: form.get('inviteCode'),
      password: form.get('password'),
      username: form.get('username'),
    }
  }
  return request.json()
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

function formFailure(message: string): Response {
  const params = new URLSearchParams({ error: message })
  return new Response(null, { status: 303, headers: { Location: `/register?${params.toString()}` } })
}

async function formSuccess(request: Request, email: string, password: string): Promise<Response> {
  const loginRes = await fetch(`${new URL(request.url).origin}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!loginRes.ok) return formFailure('注册成功但自动登录失败，请去登录')

  const headers = new Headers({ Location: '/console' })
  appendForwardedCookies(headers, loginRes.headers)
  return new Response(null, { status: 303, headers })
}

// POST /v1/auth/register —— 用户注册；邀请码可选，填写时绑定邀请关系并消耗邀请码。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const formMode = isFormRegisterRequest(request)
  const fail = (message: string, status = 400) =>
    formMode ? formFailure(message) : Response.json({ error: message }, { status })

  let body: any = {}
  try {
    body = await readRegisterBody(request, formMode)
  } catch {
    return fail('请求体无效', 400)
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : ''
  const emailRequired = await getRegistrationEmailRequired(payload)
  const normalizedEmail = normalizeRegistrationEmail(body.email)
  const accountEmail = resolveRegistrationEmail(body.email, emailRequired)
  const inputError = validateRegisterInput({
    email: normalizedEmail,
    emailRequired,
    password,
    username,
  })
  if (inputError) {
    return fail(inputError, 400)
  }

  const usernameExists = await payload
    .count({
      collection: 'users',
      where: { username: { equals: username } },
      overrideAccess: true,
    })
    .catch(() => null)
  if (usernameExists && usernameExists.totalDocs > 0) {
    return fail('用户名已被占用，请换一个', 409)
  }
  if (normalizedEmail) {
    const emailExists = await payload
      .count({
        collection: 'users',
        where: { email: { equals: normalizedEmail } },
        overrideAccess: true,
      })
      .catch(() => null)
    if (emailExists && emailExists.totalDocs > 0) {
      return fail('邮箱已被注册，请直接登录或换一个邮箱', 409)
    }
  }

  const runtimeEnv = await resolveRuntimeEnv(payload)
  // 反女巫：采集注册 IP 哈希。同 IP 24h 内注册数宽松上限（兜底极端批量；阈值宽松以规避 CGNAT/共享出口 IP 的误伤）。
  const ipHashValue = hashIp(getClientIp(request.headers, runtimeEnv))
  const deviceHashValue = hashDeviceId(body.deviceId)
  if (ipHashValue) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const recent = await payload.count({
        collection: 'users',
        where: { and: [{ ipHash: { equals: ipHashValue } }, { createdAt: { greater_than_equal: since } }] },
        overrideAccess: true,
      })
      if (recent.totalDocs >= 20) {
        return fail('同一网络注册过于频繁，请稍后再试', 429)
      }
    } catch {
      /* 频控查询失败降级放行，不阻断注册 */
    }
  }
  if (deviceHashValue) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const recent = await payload.count({
        collection: 'users',
        where: { and: [{ deviceHash: { equals: deviceHashValue } }, { createdAt: { greater_than_equal: since } }] },
        overrideAccess: true,
      })
      if (recent.totalDocs >= 5) {
        return fail('同一设备注册过于频繁，请稍后再试', 429)
      }
    } catch {
      /* 设备频控查询失败降级放行；邀请制仍是第一道门槛 */
    }
  }

  const normalizedInviteCode = typeof inviteCode === 'string' ? inviteCode.trim().toUpperCase() : ''
  let inviterId: string | undefined
  let newUser: any
  let txId: string | number | undefined
  const rollbackTx = async () => {
    if (!txId) return
    const id = txId
    txId = undefined
    await payload.db.rollbackTransaction(id).catch(() => undefined)
  }

  // 填写邀请码时，校验、建用户、标记已用必须在同一事务内；同邀请码加咨询锁防并发复用。
  try {
    txId = (await payload.db.beginTransaction?.()) || undefined
    const txReq = txId ? ({ transactionID: txId } as any) : undefined
    const tx = txReq ? { req: txReq } : {}
    let code: any
    if (normalizedInviteCode) {
      if (txId) await acquireInviteCodeLock(payload, txId, normalizedInviteCode)
      const codes = await payload.find({
        collection: 'invite-codes',
        where: { code: { equals: normalizedInviteCode } },
        limit: 1,
        overrideAccess: true,
        ...tx,
      })
      code = codes.docs[0]
      if (!code || code.status !== 'unused') {
        await rollbackTx()
        return fail('邀请码无效或已使用', 400)
      }
      if (code.expiresAt && new Date(code.expiresAt) < new Date()) {
        await rollbackTx()
        return fail('邀请码已过期', 400)
      }
      inviterId = typeof code.inviter === 'object' ? code.inviter?.id : code.inviter || undefined
    }

    newUser = await payload.create({
      collection: 'users',
      overrideAccess: true,
      ...tx,
      data: {
        email: accountEmail,
        username,
        password,
        role: 'user',
        invitedBy: inviterId || undefined,
        ipHash: ipHashValue || undefined,
        deviceHash: deviceHashValue || undefined,
      },
    })

    if (code) {
      await payload.update({
        collection: 'invite-codes',
        id: code.id,
        overrideAccess: true,
        ...tx,
        data: { status: 'used', usedBy: newUser.id },
      })
    }

    if (txId) {
      const id = txId
      await payload.db.commitTransaction(id)
      txId = undefined
    }
  } catch (e: any) {
    await rollbackTx()
    payload.logger?.error(`注册失败: ${e?.message}`)
    return fail(registerCreateErrorMessage(e), 400)
  }

  // 给邀请人发术值（分值/每日上限由 contribution-rules 的 invite 规则决定）；
  // 同 IP 自邀不发，根治用自己网络的小号刷邀请分（只扣奖励、不阻断注册，几乎无误伤）。
  if (inviterId) {
    let sameIp = false
    let sameDevice = false
    if (ipHashValue || deviceHashValue) {
      const inviter = await payload
        .findByID({ collection: 'users', id: inviterId, overrideAccess: true, depth: 0 })
        .catch(() => null)
      sameIp = !!(ipHashValue && inviter && (inviter as any).ipHash && (inviter as any).ipHash === ipHashValue)
      sameDevice = !!(
        deviceHashValue &&
        inviter &&
        (inviter as any).deviceHash &&
        (inviter as any).deviceHash === deviceHashValue
      )
    }
    if (!sameIp && !sameDevice) {
      await awardContribution(payload, {
        userId: inviterId,
        actionType: 'invite',
        description: '邀请新用户注册',
      })
    }
  }

  let freeGranted = 0
  // 注册赠送 credit（免费额度 F，economy-settings 配置，默认 0=不送；幂等键防重）
  try {
    const eco = await getEconomyConfig(payload)
    const free = normalizeRegisterCreditAmount(eco.freeCreditOnRegister)
    if (free > 0) {
      const grant = await applyCredit(payload, {
        userId: newUser.id as string,
        type: 'adjust',
        amount: free,
        description: '注册赠送额度',
        idempotencyKey: registerCreditIdempotencyKey(newUser.id as string),
      })
      if (grant.ok && !grant.skipped) freeGranted = free
    }
  } catch (e) {
    payload.logger?.error(`注册赠送 credit 失败: ${(e as Error).message}`)
  }

  // 预建 New API 子令牌（best-effort）；若注册赠送 credit，也尽力同步子令牌配额，避免本地有余额但网关 0 quota。
  const admin = getNewApiAdmin(runtimeEnv)
  admin
    .provisionSubToken(newUser.id as string)
    .then(() => (freeGranted > 0 ? syncNewApiQuotaToBalance(payload, newUser.id as string) : undefined))
    .catch((e) => payload.logger?.error(`预建/同步子令牌失败: ${(e as Error).message}`))

  if (formMode) return formSuccess(request, accountEmail, password)
  return Response.json({ ok: true, userId: newUser.id, loginEmail: accountEmail })
}
