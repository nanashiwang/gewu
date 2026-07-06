import 'dotenv/config'
import { getPayload } from 'payload'
import config from '@payload-config'
import { chatCompletion } from '@/lib/newapi'
import { getCreditToQuota, getNewApiAdmin } from '@/lib/newapiAdmin'
import {
  assertCalibrationUsageDelta,
  resolveCalibrationCredits,
  resolveCalibrationModel,
  validateCalibrationEnv,
} from '@/lib/newapiCalibration'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

const APPLY = process.argv.includes('--apply')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (!APPLY) {
    console.error('这是会真实创建临时子令牌并发起小额模型调用的校准脚本；确认后加 --apply。')
    console.error('要求 NEWAPI_CALIBRATE_USER_ID 使用 calib- 前缀，避免覆盖真实用户子令牌。')
    process.exit(0)
  }

  const payload = await getPayload({ config })
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const calibrationEnv: Record<string, string | undefined> = {
    ...runtimeEnv,
    NEWAPI_CALIBRATE_USER_ID: process.env.NEWAPI_CALIBRATE_USER_ID,
    NEWAPI_CALIBRATE_CREDITS: process.env.NEWAPI_CALIBRATE_CREDITS,
    NEWAPI_CALIBRATE_MODEL: process.env.NEWAPI_CALIBRATE_MODEL,
  }
  const admin = getNewApiAdmin(calibrationEnv)
  if (admin.mode !== 'real') throw new Error('New API 管理 API 未配置为 real 模式')

  const errors = validateCalibrationEnv(calibrationEnv)
  if (errors.length) throw new Error(errors.join('；'))

  const userId = calibrationEnv.NEWAPI_CALIBRATE_USER_ID as string
  const credits = resolveCalibrationCredits(calibrationEnv)
  const creditedQuota = Math.round(credits * getCreditToQuota(calibrationEnv, { requireExplicit: true }))
  const model = resolveCalibrationModel(calibrationEnv)
  if (!model) throw new Error('无法选择校准模型')

  const sinceMs = Date.now() - 5 * 60 * 1000
  // 先查日志权限：失败则不创建/不改子令牌，避免无 /api/log 权限时误以为真钱闭环已验收。
  const before = await admin.fetchUsage(userId, sinceMs)

  let tokenWasProvisioned = false
  let report: Record<string, unknown> | null = null
  try {
    const token = await admin.provisionSubToken(userId)
    tokenWasProvisioned = true
    if (!token.key) throw new Error('New API 子令牌未返回 key，无法进行真实调用校准')
    await admin.setQuotaToCredits(userId, credits)

    const result = await chatCompletion({
      model,
      apiKey: token.key,
      maxTokens: 16,
      messages: [{ role: 'user', content: '用一句中文回答：ok' }],
      gateway: { baseUrl: calibrationEnv.MODEL_GATEWAY_BASE_URL, apiKey: calibrationEnv.MODEL_GATEWAY_KEY },
      metadata: { source: 'newapi-calibration', runId: `calib-${Date.now()}` },
    })
    if (result.mocked) throw new Error('校准调用走了 mock，不是 New API 真调用')

    let after = before
    for (let i = 0; i < 8; i++) {
      after = await admin.fetchUsage(userId, sinceMs)
      if (after.usedQuota > before.usedQuota) break
      await sleep(1000)
    }

    const deltaCalls = after.calls - before.calls
    const deltaQuota = after.usedQuota - before.usedQuota
    const deltaCostCents = after.costCents - before.costCents
    assertCalibrationUsageDelta(deltaQuota, creditedQuota, deltaCalls)

    let badKeyRejected = false
    try {
      await chatCompletion({
        model,
        apiKey: 'sk-invalid-calibration-key',
        maxTokens: 4,
        messages: [{ role: 'user', content: 'should fail' }],
        gateway: { baseUrl: calibrationEnv.MODEL_GATEWAY_BASE_URL, apiKey: calibrationEnv.MODEL_GATEWAY_KEY },
        metadata: { source: 'newapi-calibration-bad-key', runId: `calib-bad-${Date.now()}` },
      })
    } catch {
      badKeyRejected = true
    }
    if (!badKeyRejected) throw new Error('坏 BYOK Key 未被拒绝，网关鉴权异常')

    const finalUsage = await admin.fetchUsage(userId, sinceMs)
    const badKeyCostDelta = finalUsage.costCents - after.costCents
    const badKeyQuotaDelta = finalUsage.usedQuota - after.usedQuota
    if (badKeyQuotaDelta > 0) {
      throw new Error('坏 BYOK Key 被拒后仍产生 quota 消费，网关计费隔离异常')
    }

    report = {
      ok: true,
      userId,
      model,
      creditedQuota,
      realCall: {
        model: result.model,
        totalTokens: result.totalTokens,
        deltaCalls,
        deltaQuota,
        deltaCostCents,
      },
      badByok: {
        rejected: badKeyRejected,
        extraQuotaAfterBadKey: badKeyQuotaDelta,
        extraCostCentsAfterBadKey: badKeyCostDelta,
      },
    }
  } finally {
    if (tokenWasProvisioned) {
      try {
        await admin.setQuotaToCredits(userId, 0)
      } catch (e) {
        throw new Error(`校准临时子令牌 quota 清零失败，请手动清零 hs_${userId}: ${(e as Error).message}`)
      }
    }
  }

  if (report) {
    console.log(
      JSON.stringify(
        {
          ...report,
          cleanup: { tempQuotaZeroed: tokenWasProvisioned },
        },
        null,
        2,
      ),
    )
  }
}

main().catch((e) => {
  console.error(`New API 小额闭环校准失败：${(e as Error).message}`)
  process.exit(1)
})
