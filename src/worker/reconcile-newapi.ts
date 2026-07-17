import 'dotenv/config'
import { getPayload } from 'payload'
import config from '@payload-config'
import { getCreditToQuota, getNewApiAdmin } from '@/lib/newapiAdmin'
import { sumCreditAmount } from '@/lib/economy'
import { economyMarginReconcileContext } from '@/lib/economySettingsGuard'
import { writeUserDriftReportFile } from '@/lib/newapiDriftReport'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'
import {
  buildUserUsageDriftReport,
  calculateModelMarginCents,
  calculateTokenPricedCostCents,
  compareUsageDrift,
  mergeModelUsageRows,
  resolveReconcileModelMarginRates,
  resolveReconcileMarginRate,
  resolveReconcileToleranceCents,
  resolveUsageSource,
  type ModelUsageForMargin,
  type UserUsageDriftInput,
} from '@/lib/newapiReconcile'

const APPLY = process.argv.includes('--apply')
const monthStart = new Date()
monthStart.setDate(1)
monthStart.setHours(0, 0, 0, 0)
const sinceMs = monthStart.getTime()

function cents(n: number): number {
  return Math.max(0, Math.round(n || 0))
}

async function main() {
  const payload = await getPayload({ config })
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const usageSource = resolveUsageSource(runtimeEnv)
  const flatMarginRate = resolveReconcileMarginRate(runtimeEnv, { requirePositive: APPLY && usageSource === 'local' })
  const modelMarginRates = resolveReconcileModelMarginRates(runtimeEnv)
  const explicitDriftTolerance = resolveReconcileToleranceCents(runtimeEnv)
  const admin = getNewApiAdmin(runtimeEnv)
  if (usageSource === 'local' && flatMarginRate <= 0) {
    payload.logger.warn('NEWAPI_MARGIN_RATE 未配置或为 0：只拉用量，不会打开兑换池毛利')
  }
  if (usageSource === 'newapi' && modelMarginRates.size > 0) {
    payload.logger.warn('NEWAPI_MODEL_MARGIN_RATES 仅保留作 dry-run 对照；真钱写回优先使用 /api/pricing × token 用量')
  }

  let users = 0
  let calls = 0
  let usedQuota = 0
  let revenueCents = 0
  let localConsumeCents = 0
  let missingModelCalls = 0
  let quotaPerCredit: number | undefined
  let pricingSnapshot: Awaited<ReturnType<typeof admin.fetchPricing>> | null = null
  const modelUsageRows: ModelUsageForMargin[] = []

  if (usageSource === 'local') {
    if (APPLY && runtimeEnv.ALLOW_LOCAL_MARGIN_EXCHANGE !== '1') {
      payload.logger.error(
        'NEWAPI_USAGE_SOURCE=local 只能作为保守估算；写回兑换池前必须显式设置 ALLOW_LOCAL_MARGIN_EXCHANGE=1',
      )
      process.exit(2)
    }
    const sinceISO = monthStart.toISOString()
    const consumed = await sumCreditAmount(payload, { type: 'consume', sinceISO })
    const count = await payload.count({
      collection: 'credit-logs',
      where: { and: [{ type: { equals: 'consume' } }, { createdAt: { greater_than_equal: sinceISO } }] },
      overrideAccess: true,
    })
    calls = count.totalDocs
    revenueCents = cents(-consumed)
    localConsumeCents = revenueCents
    payload.logger.warn(
      'NEWAPI_USAGE_SOURCE=local：使用本平台 credit consume 估算收入，非 New API /api/log 真值；--apply 需同时设置 ALLOW_LOCAL_MARGIN_EXCHANGE=1',
    )
  } else {
    if (admin.mode !== 'real') {
      payload.logger.warn('New API 管理 API 未配置，跳过真实用量/毛利对账')
      process.exit(0)
    }
    quotaPerCredit = getCreditToQuota(runtimeEnv, { requireExplicit: true })
    try {
      pricingSnapshot = await admin.fetchPricing()
    } catch (e) {
      const msg = `NewAPI /api/pricing 或 /api/status 不可用，无法用 token×价格精算成本；禁止写回毛利。原因：${(e as Error).message}`
      if (APPLY) {
        payload.logger.error(msg)
        process.exit(2)
      }
      payload.logger.warn(msg)
    }
    let page = 1
    let usageError: string | null = null
    const sinceISO = monthStart.toISOString()
    const perUserRows: UserUsageDriftInput[] = []
    for (;;) {
      const res = await payload.find({ collection: 'users', depth: 0, limit: 100, page, overrideAccess: true, sort: 'id' })
      for (const u of res.docs as any[]) {
        const userId = String(u.id)
        try {
          const usage = await admin.fetchUsage(userId, sinceMs)
          const localUserCents = cents(-(await sumCreditAmount(payload, { type: 'consume', sinceISO, userId })))
          perUserRows.push({
            userId,
            newapiUsageCents: usage.costCents,
            localConsumeCents: localUserCents,
          })
          users++
          calls += usage.calls
          usedQuota += usage.usedQuota
          revenueCents += usage.costCents
          missingModelCalls += usage.missingModelCalls
          modelUsageRows.push(...usage.byModel)
        } catch (e) {
          usageError = (e as Error).message
          break
        }
      }
      if (usageError || !res.hasNextPage) break
      page++
    }

    if (usageError) {
      payload.logger.error(
        `NewAPI /api/log 不可用，无法回填真实毛利；禁止据此开启 exchangeEnabled。原因：${usageError.replace(/gw_[A-Za-z0-9-]+/g, 'gw_<user>')}`,
      )
      process.exit(2)
    }
    if (APPLY && calls > 0 && usedQuota <= 0) {
      payload.logger.error('NewAPI /api/log 有调用记录但无 quota 消费字段，无法校准 CREDIT_TO_QUOTA；禁止写回毛利')
      process.exit(2)
    }
    localConsumeCents = cents(-(await sumCreditAmount(payload, { type: 'consume', sinceISO })))
    const drift = compareUsageDrift(revenueCents, localConsumeCents, explicitDriftTolerance)
    const perUserDrifts = buildUserUsageDriftReport(perUserRows, explicitDriftTolerance).filter((d) => !d.ok)
    payload.logger.info(
      `NewAPI 对账漂移：newapi=${revenueCents} 分 local=${localConsumeCents} 分 drift=${drift.driftCents} 分 tolerance=${drift.toleranceCents} 分`,
    )
    for (const d of perUserDrifts.slice(0, 20)) {
      payload.logger.error(
        `NewAPI 用户对账漂移 user=${d.userId} newapi=${d.newapiUsageCents} 分 local=${d.localConsumeCents} 分 drift=${d.driftCents} 分 tolerance=${d.toleranceCents} 分 action=${d.action}`,
      )
    }
    const reportPath = await writeUserDriftReportFile(perUserDrifts, {
      explicitPath: runtimeEnv.NEWAPI_RECONCILE_DRIFT_REPORT_PATH,
      monthStart,
      usageSource,
    })
    if (reportPath) payload.logger.error(`NewAPI 逐用户漂移处理清单已导出：${reportPath}`)
    if (APPLY && !drift.ok) {
      payload.logger.error(
        'NewAPI /api/log 消费与本地 credit consume 偏差过大；请先校准 NEWAPI_CREDIT_TO_QUOTA / 模型价格 / 扣费口径，禁止写回毛利',
      )
      process.exit(2)
    }
    if (APPLY && perUserDrifts.length > 0) {
      payload.logger.error(
        `NewAPI 逐用户对账发现 ${perUserDrifts.length} 个用户漂移；请按 action 人工补扣/退款/修复网关少扣后再写回毛利`,
      )
      process.exit(2)
    }
  }

  let marginCents = 0
  let marginLabel = ''
  if (usageSource === 'newapi') {
    const mergedModelUsageRows = mergeModelUsageRows(modelUsageRows, { quotaPerCredit })
    if (pricingSnapshot) {
      try {
        const tokenCost = calculateTokenPricedCostCents(mergedModelUsageRows, pricingSnapshot.models, {
          requireAllModels: APPLY,
          quotaPerUnit: pricingSnapshot.quotaPerUnit,
          usdToCny: pricingSnapshot.usdToCny,
        })
        const pricingDrift = compareUsageDrift(tokenCost.costCents, revenueCents, explicitDriftTolerance)
        payload.logger.info(
          `NewAPI 价格复算：token×price=${tokenCost.costCents} 分 quota扣费=${revenueCents} 分 drift=${pricingDrift.driftCents} 分 tolerance=${pricingDrift.toleranceCents} 分`,
        )
        if (APPLY && !pricingDrift.ok) {
          payload.logger.error('NewAPI token×price 与 quota 实扣偏差过大；请先校准 /api/pricing、group_ratio、汇率或 CREDIT_TO_QUOTA')
          process.exit(2)
        }
        marginCents = Math.max(0, localConsumeCents - tokenCost.costCents)
        marginLabel = `按 token×/api/pricing 精算成本 ${tokenCost.costCents} 分（group=${pricingSnapshot.group}，usdToCny=${pricingSnapshot.usdToCny}）`
        if (!APPLY && tokenCost.missingModels.length > 0) {
          payload.logger.warn(`NewAPI 价格 dry-run 不完整：缺模型价格 ${tokenCost.missingModels.join(',')}`)
        }
      } catch (e) {
        payload.logger.error(`${(e as Error).message}；禁止写回毛利`)
        process.exit(2)
      }
    } else if (modelMarginRates.size > 0) {
      try {
        const modelMargin = calculateModelMarginCents(mergedModelUsageRows, modelMarginRates, {
          requireAllModels: false,
          missingModelCalls,
        })
        marginCents = modelMargin.marginCents
        marginLabel = `按模型毛利率 dry-run ${modelMargin.byModel.map((r) => `${r.modelName}:${r.marginRate}`).join(',') || '无调用'}`
        if (!APPLY && (modelMargin.missingModels.length > 0 || missingModelCalls > 0)) {
          payload.logger.warn(
            `NewAPI 模型毛利 dry-run 不完整：缺模型字段 ${missingModelCalls} 条，缺倍率 ${modelMargin.missingModels.join(',') || '无'}`,
          )
        }
      } catch (e) {
        payload.logger.error(`${(e as Error).message}；禁止写回毛利`)
        process.exit(2)
      }
    } else if (flatMarginRate > 0 && runtimeEnv.ALLOW_FLAT_NEWAPI_MARGIN_RATE === '1') {
      // 只允许 dry-run 观察旧单一毛利口径；真钱写回必须走 token×/api/pricing。
      marginCents = cents(revenueCents * flatMarginRate)
      marginLabel = `单一毛利率 dry-run ${flatMarginRate}`
      payload.logger.warn('ALLOW_FLAT_NEWAPI_MARGIN_RATE=1 仅用于 dry-run 对照；--apply 必须取得 /api/pricing 与 /api/status')
    } else {
      marginLabel = '未取得 /api/pricing token 价格快照'
    }
  } else {
    marginCents = cents(revenueCents * flatMarginRate)
    marginLabel = `local 单一毛利率 ${flatMarginRate}`
  }
  payload.logger.info(
    `NewAPI 对账：用户 ${users}，调用 ${calls}，quota ${usedQuota}，NewAPI扣费 ${revenueCents} 分，本地消费 ${localConsumeCents} 分，${marginLabel}，毛利 ${marginCents} 分${APPLY ? '（写回）' : '（dry-run）'}`,
  )

  if (APPLY) {
    await payload.updateGlobal({
      slug: 'economy-settings',
      context: economyMarginReconcileContext(),
      data: {
        monthlyRealizedMarginCents: marginCents,
        marginSource: usageSource,
        marginReconciledAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
