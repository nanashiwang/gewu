import { getPayload } from 'payload'
import config from '@payload-config'
import type { PayloadRequest } from 'payload'
import { headers as nextHeaders } from 'next/headers'
import { awardContribution } from '@/lib/contribution'
import { applyCredit } from '@/lib/credit'
import { getNewApiAdmin } from '@/lib/newapiAdmin'
import {
  getEconomyConfig,
  exchangePoolRemaining,
  userExchangedInWindow,
  acquireExchangeLock,
  dayStartISO,
  monthStartISO,
} from '@/lib/economy'

// GET /v1/economy/exchange —— 兑换状态（前台 UI 用，隐藏原始毛利）
export async function GET() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })

  const cfg = await getEconomyConfig(payload)
  const full = (await payload
    .findByID({ collection: 'users', id: user.id, overrideAccess: true, depth: 0 })
    .catch(() => null)) as any

  const poolRemaining = await exchangePoolRemaining(payload, cfg)
  const dailyUsed = await userExchangedInWindow(payload, user.id as string, dayStartISO())
  const monthlyUsed = await userExchangedInWindow(payload, user.id as string, monthStartISO())

  return Response.json({
    enabled: cfg.exchangeEnabled,
    pointsPerCredit: cfg.pointsPerCredit,
    minCreditPerTx: cfg.minCreditPerTx,
    perTxMaxCredit: cfg.perTxMaxCredit,
    poolRemainingCredit: poolRemaining,
    userDailyRemaining: Math.max(0, cfg.perUserDailyMaxCredit - dailyUsed),
    userMonthlyRemaining: Math.max(0, cfg.perUserMonthlyMaxCredit - monthlyUsed),
    contributionScore: full?.contributionScore || 0,
    creditBalance: full?.creditBalance || 0,
  })
}

// POST /v1/economy/exchange —— 术值 → credit 兑换
// 保命红线：兑换池 = α × 当月已实现毛利，先赚到才有得兑，永不亏 margin。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })
  const uid = user.id as string

  const cfg = await getEconomyConfig(payload)
  if (!cfg.exchangeEnabled) return Response.json({ error: '术值兑换暂未开放' }, { status: 403 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* 容忍空 body */
  }
  const credit = Math.floor(Number(body.credit))
  const idempotencyKey: string | undefined =
    typeof body.idempotencyKey === 'string' && body.idempotencyKey ? body.idempotencyKey.slice(0, 80) : undefined

  // 碰钱写操作强制幂等键：缺失则拒（防网络重试/双击产生两笔真实兑换，绕过全部去重）
  if (!idempotencyKey) {
    return Response.json({ error: '缺少幂等键 idempotencyKey' }, { status: 400 })
  }
  if (!Number.isFinite(credit) || credit <= 0) {
    return Response.json({ error: '请填写有效的兑换 credit 数' }, { status: 400 })
  }
  if (credit < cfg.minCreditPerTx) {
    return Response.json({ error: `单次至少兑换 ${cfg.minCreditPerTx} credit` }, { status: 400 })
  }
  if (credit > cfg.perTxMaxCredit) {
    return Response.json({ error: `单次最多兑换 ${cfg.perTxMaxCredit} credit` }, { status: 400 })
  }

  // 幂等：整笔兑换以 idempotencyKey 去重（避免重试同时扣术值 + 发 credit 各出问题）
  {
    const dup = await payload.count({
      collection: 'credit-logs',
      where: { idempotencyKey: { equals: idempotencyKey } },
      overrideAccess: true,
    })
    if (dup.totalDocs > 0) {
      return Response.json({ ok: true, already: true, message: '该兑换已处理' })
    }
  }

  const pointsCost = credit * cfg.pointsPerCredit

  // 事务外快速预检（友好报错；权威校验在事务内加锁后复核）
  const pre = (await payload
    .findByID({ collection: 'users', id: uid, overrideAccess: true, depth: 0 })
    .catch(() => null)) as any
  if (!pre || (pre.contributionScore || 0) < pointsCost) {
    return Response.json({ error: `术值不足，需 ${pointsCost}` }, { status: 400 })
  }

  // ── 原子结算：全局咨询锁串行化 → 事务内复核池/额度/术值 → 扣术值 + 发 credit ──
  const transactionID = await payload.db.beginTransaction()
  if (!transactionID) {
    return Response.json({ error: '事务不可用，兑换暂不可用' }, { status: 503 })
  }
  const txReq: Partial<PayloadRequest> = { transactionID }
  try {
    // 关键：先取全局兑换锁，之后所有复核读(READ COMMITTED)才能看见此前已提交的兑换，杜绝池超支/术值透支
    await acquireExchangeLock(payload, transactionID)

    // 复核术值余额
    const u2 = (await payload.findByID({
      collection: 'users',
      id: uid,
      overrideAccess: true,
      depth: 0,
      req: txReq,
    })) as any
    if ((u2.contributionScore || 0) < pointsCost) throw new Error('术值不足')

    // 复核每日/每月/池上限（均在锁内，看到全部已提交兑换）
    const dailyUsed = await userExchangedInWindow(payload, uid, dayStartISO(), txReq)
    if (dailyUsed + credit > cfg.perUserDailyMaxCredit) throw new Error('超出每日兑换上限')
    const monthlyUsed = await userExchangedInWindow(payload, uid, monthStartISO(), txReq)
    if (monthlyUsed + credit > cfg.perUserMonthlyMaxCredit) throw new Error('超出每月兑换上限')
    const poolRemaining = await exchangePoolRemaining(payload, cfg, txReq)
    if (credit > poolRemaining) throw new Error('兑换池余额不足（先赚到才有得兑）')

    await awardContribution(payload, {
      userId: uid,
      actionType: 'consume',
      points: -pointsCost,
      description: `兑换 ${credit} credit`,
      req: txReq,
      throwOnError: true,
    })

    const grant = await applyCredit(payload, {
      userId: uid,
      type: 'exchange',
      amount: credit,
      description: `术值兑换（-${pointsCost} 术值）`,
      idempotencyKey,
      req: txReq,
      throwOnError: true,
    })
    // 若 applyCredit 因幂等命中而跳过，则术值已扣但 credit 未发 → 必须回滚
    if (!grant.ok || grant.skipped) {
      throw new Error(grant.skipped ? '兑换重复（幂等）' : grant.error || '发放 credit 失败')
    }

    await payload.db.commitTransaction(transactionID)

    // 提交后尽力同步网关子令牌配额（stub 模式为 no-op；失败不影响权威账本，靠对账补偿）
    getNewApiAdmin()
      .adjustQuota(uid, credit)
      .catch((e) => payload.logger?.error(`兑换后网关配额同步失败: ${(e as Error).message}`))

    return Response.json({
      ok: true,
      creditGranted: credit,
      pointsSpent: pointsCost,
      newCreditBalance: grant.balance,
    })
  } catch (e) {
    await payload.db.rollbackTransaction(transactionID)
    return Response.json({ error: (e as Error).message || '兑换失败' }, { status: 400 })
  }
}
