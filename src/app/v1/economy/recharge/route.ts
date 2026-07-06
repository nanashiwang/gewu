import { getPayload } from 'payload'
import type { PayloadRequest } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { applyCredit } from '@/lib/credit'
import { acquireExchangeLock } from '@/lib/economy'
import { syncNewApiQuotaToBalance } from '@/lib/newapiQuota'
import { maskRechargeCode, normalizeRechargeCode, rechargeCodeDigest, resolveRechargeCreditAmount } from '@/lib/rechargeCodes'
import { consumeStrictRedisRateLimit } from '@/lib/rateLimit'
import { recordAuditEvent } from '@/lib/audit'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

const DEFAULT_RECHARGE_ATTEMPT_LIMIT_PER_10MIN = 10

// POST /v1/economy/recharge —— 一次性充值码 → credit。
// 低频资金入口，复用全局咨询锁串行化，避免同一码并发双兑。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })

  const runtimeEnv = await resolveRuntimeEnv(payload)
  const rechargeAttemptLimit = Math.max(
    1,
    Number(runtimeEnv.RECHARGE_ATTEMPT_LIMIT_PER_10MIN || DEFAULT_RECHARGE_ATTEMPT_LIMIT_PER_10MIN),
  )
  const rateLimit = await consumeStrictRedisRateLimit({
    payload,
    scope: 'recharge',
    subject: user.id as string,
    limit: rechargeAttemptLimit,
    windowSeconds: 10 * 60,
  })
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error: rateLimit.unavailable
          ? '系统繁忙，请稍后再试'
          : `充值尝试过于频繁（10 分钟上限 ${rechargeAttemptLimit} 次），请稍后再试`,
      },
      { status: 429 },
    )
  }

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '请求体无效' }, { status: 400 })
  }
  const codeText = normalizeRechargeCode(body.code)
  if (!codeText) return Response.json({ error: '请输入充值码' }, { status: 400 })
  const codeHash = rechargeCodeDigest(codeText)

  const transactionID = await payload.db.beginTransaction()
  if (!transactionID) return Response.json({ error: '事务不可用，充值暂不可用' }, { status: 503 })
  const txReq: Partial<PayloadRequest> = { transactionID }

  try {
    await acquireExchangeLock(payload, transactionID)
    const codes = await payload.find({
      collection: 'recharge-codes',
      where: { codeHash: { equals: codeHash } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      req: txReq,
    })
    const code = codes.docs[0] as any
    if (!code || code.status !== 'unused') throw new Error('充值码无效或已使用')
    if (code.expiresAt && new Date(code.expiresAt) < new Date()) throw new Error('充值码已过期')
    const credit = resolveRechargeCreditAmount(code.creditAmount)

    await payload.update({
      collection: 'recharge-codes',
      id: code.id,
      data: { status: 'used', usedBy: user.id, usedAt: new Date().toISOString() },
      overrideAccess: true,
      context: { allowRechargeCodeServiceUpdate: true },
      req: txReq,
    })
    const grant = await applyCredit(payload, {
      userId: user.id as string,
      type: 'recharge',
      amount: credit,
      description: `充值码 ${code.codePreview || maskRechargeCode(codeText)}`,
      idempotencyKey: `recharge:${code.id}`,
      req: txReq,
      throwOnError: true,
    })
    if (!grant.ok || grant.skipped) throw new Error(grant.skipped ? '充值码已处理' : grant.error || '充值失败')

    await payload.db.commitTransaction(transactionID)

    syncNewApiQuotaToBalance(payload, user.id as string).catch((e) =>
      payload.logger?.error(`充值后网关配额同步失败: ${(e as Error).message}`),
    )
    await recordAuditEvent(payload, {
      event: 'credit_recharged',
      actorId: user.id as string,
      targetUserId: user.id as string,
      targetType: 'recharge-code',
      targetId: code.id,
      summary: `充值码兑换 ${credit} credit`,
      metadata: { creditGranted: credit, codePreview: code.codePreview || maskRechargeCode(codeText) },
      request,
    })

    return Response.json({ ok: true, creditGranted: credit, newCreditBalance: grant.balance })
  } catch (e) {
    await payload.db.rollbackTransaction(transactionID)
    return Response.json({ error: (e as Error).message || '充值失败' }, { status: 400 })
  }
}
