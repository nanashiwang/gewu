import { getPayload } from 'payload'
import config from '@payload-config'
import { awardContribution } from '@/lib/contribution'
import { applyCredit } from '@/lib/credit'
import { getEconomyConfig } from '@/lib/economy'
import { getClientIp, hashIp } from '@/lib/clientMeta'

// POST /v1/auth/register —— 邀请码注册
export async function POST(request: Request) {
  const payload = await getPayload({ config })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '请求体无效' }, { status: 400 })
  }
  const { email, username, password, inviteCode } = body
  if (!email || !username || !password) {
    return Response.json({ error: '邮箱、用户名、密码均为必填' }, { status: 400 })
  }
  if (!inviteCode) {
    return Response.json({ error: '需要邀请码' }, { status: 400 })
  }

  // 反女巫：采集注册 IP 哈希。同 IP 24h 内注册数宽松上限（兜底极端批量；注册本已被邀请码强约束；
  // 阈值宽松以规避 CGNAT/共享出口 IP 的误伤）。
  const ipHashValue = hashIp(getClientIp(request.headers))
  if (ipHashValue) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const recent = await payload.count({
        collection: 'users',
        where: { and: [{ ipHash: { equals: ipHashValue } }, { createdAt: { greater_than_equal: since } }] },
        overrideAccess: true,
      })
      if (recent.totalDocs >= 20) {
        return Response.json({ error: '同一网络注册过于频繁，请稍后再试' }, { status: 429 })
      }
    } catch {
      /* 频控查询失败降级放行，不阻断注册 */
    }
  }

  // 校验邀请码
  const codes = await payload.find({
    collection: 'invite-codes',
    where: { code: { equals: String(inviteCode).trim().toUpperCase() } },
    limit: 1,
    overrideAccess: true,
  })
  const code = codes.docs[0]
  if (!code || code.status !== 'unused') {
    return Response.json({ error: '邀请码无效或已使用' }, { status: 400 })
  }
  if (code.expiresAt && new Date(code.expiresAt) < new Date()) {
    return Response.json({ error: '邀请码已过期' }, { status: 400 })
  }

  const inviterId = typeof code.inviter === 'object' ? code.inviter?.id : code.inviter

  // 建用户
  let newUser
  try {
    newUser = await payload.create({
      collection: 'users',
      overrideAccess: true,
      data: {
        email,
        username,
        password,
        role: 'user',
        invitedBy: inviterId || undefined,
        ipHash: ipHashValue || undefined,
      },
    })
  } catch (e: any) {
    // 通用文案防账号枚举：不回显"邮箱已存在/用户名已占用"等可区分错误；原始错误仅落服务端日志
    payload.logger?.error(`注册失败: ${e?.message}`)
    return Response.json({ error: '注册失败，请检查信息或稍后重试' }, { status: 400 })
  }

  // 标记邀请码已用
  await payload.update({
    collection: 'invite-codes',
    id: code.id,
    overrideAccess: true,
    data: { status: 'used', usedBy: newUser.id },
  })

  // 给邀请人发术值（分值/每日上限由 contribution-rules 的 invite 规则决定）；
  // 同 IP 自邀不发，根治用自己网络的小号刷邀请分（只扣奖励、不阻断注册，几乎无误伤）。
  if (inviterId) {
    let sameIp = false
    if (ipHashValue) {
      const inviter = await payload
        .findByID({ collection: 'users', id: inviterId, overrideAccess: true, depth: 0 })
        .catch(() => null)
      sameIp = !!(inviter && (inviter as any).ipHash && (inviter as any).ipHash === ipHashValue)
    }
    if (!sameIp) {
      await awardContribution(payload, {
        userId: inviterId,
        actionType: 'invite',
        description: '邀请新用户注册',
      })
    }
  }

  // 注册赠送 credit（免费额度 F，economy-settings 配置，默认 0=不送；幂等键防重）
  try {
    const eco = await getEconomyConfig(payload)
    const free = eco.freeCreditOnRegister
    if (free > 0) {
      await applyCredit(payload, {
        userId: newUser.id as string,
        type: 'adjust',
        amount: free,
        description: '注册赠送额度',
        idempotencyKey: `register:${newUser.id}`,
      })
    }
  } catch (e) {
    payload.logger?.error(`注册赠送 credit 失败: ${(e as Error).message}`)
  }

  return Response.json({ ok: true, userId: newUser.id })
}
