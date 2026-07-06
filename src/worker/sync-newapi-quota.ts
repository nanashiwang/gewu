import 'dotenv/config'
import { getPayload } from 'payload'
import config from '@payload-config'
import { getNewApiAdmin } from '@/lib/newapiAdmin'
import { quotaCreditsForUser, syncNewApiQuotaToBalance } from '@/lib/newapiQuota'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1'

async function main() {
  const payload = await getPayload({ config })
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const admin = getNewApiAdmin(runtimeEnv)
  if (admin.mode !== 'real') {
    payload.logger.warn('New API 管理 API 未配置，跳过子令牌 quota 同步')
    process.exit(0)
  }

  let page = 1
  let scanned = 0
  let synced = 0
  let failed = 0
  for (;;) {
    const res = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 100,
      page,
      overrideAccess: true,
      sort: 'id',
    })
    for (const u of res.docs as any[]) {
      scanned++
      const targetCredits = quotaCreditsForUser(u)
      if (!APPLY) {
        payload.logger.info(
          `dry-run: user=${u.id} status=${u.accountStatus || 'active'} targetCredits=${targetCredits}`,
        )
        continue
      }
      try {
        await syncNewApiQuotaToBalance(payload, String(u.id))
        synced++
      } catch (e) {
        failed++
        payload.logger.error(`同步子令牌 quota 失败 user=${u.id}: ${(e as Error).message}`)
      }
    }
    if (!res.hasNextPage) break
    page++
  }

  payload.logger.info(
    `New API quota 同步：扫描 ${scanned}，${APPLY ? `成功 ${synced}，失败 ${failed}` : 'dry-run 未写回'}`,
  )
  process.exit(failed > 0 ? 2 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
