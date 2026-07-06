import 'dotenv/config'
import { getPayload } from 'payload'
import type { Payload } from 'payload'
import config from '@payload-config'
import { checkProductionEnv, checkStartupEnv, countBlockers } from '@/lib/productionPreflight'
import { classifyNewApiProbe, redactNewApiProbeText, runNewApiPermissionProbe } from '@/lib/newapiProbe'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

type CollectionSlug = 'favorites' | 'reviews' | 'skill-installs'

type DuplicateSpec = {
  collection: CollectionSlug
  label: string
  fields: string[]
}

const SPECS: DuplicateSpec[] = [
  { collection: 'favorites', label: '收藏唯一约束 Favorites(user,skill)', fields: ['user', 'skill'] },
  { collection: 'reviews', label: '评价唯一约束 Reviews(user,skill,type)', fields: ['user', 'skill', 'type'] },
  {
    collection: 'skill-installs',
    label: '安装唯一约束 SkillInstalls(user,skill,runner)',
    fields: ['user', 'skill', 'runner'],
  },
]

function relationId(v: unknown): string {
  if (!v) return 'NULL'
  if (typeof v === 'object' && 'id' in v) return String((v as { id?: unknown }).id || 'NULL')
  return String(v)
}

function valueFor(doc: Record<string, unknown>, field: string): string {
  return relationId(doc[field])
}

async function forEachDoc(payload: Payload, collection: CollectionSlug, cb: (doc: any) => void) {
  const limit = 500
  let page = 1
  for (;;) {
    const res = await payload.find({
      collection,
      depth: 0,
      limit,
      page,
      overrideAccess: true,
      sort: 'id',
    })
    for (const d of res.docs as any[]) cb(d)
    if (!res.hasNextPage) break
    page++
  }
}

async function checkDuplicates(payload: Payload, spec: DuplicateSpec): Promise<number> {
  const groups = new Map<string, { count: number; ids: string[] }>()
  await forEachDoc(payload, spec.collection, (doc) => {
    const key = spec.fields.map((f) => valueFor(doc, f)).join('|')
    const g = groups.get(key) || { count: 0, ids: [] }
    g.count++
    if (g.ids.length < 8) g.ids.push(String(doc.id))
    groups.set(key, g)
  })

  let duplicateGroups = 0
  for (const [key, g] of groups) {
    if (g.count <= 1) continue
    duplicateGroups++
    payload.logger.error(`${spec.label} 存在重复：key=${key} count=${g.count} sampleIds=${g.ids.join(',')}`)
  }
  if (duplicateGroups === 0) {
    payload.logger.info(`${spec.label}：OK，无重复`)
  }
  return duplicateGroups
}

async function checkInstalledRecordsHaveRunner(payload: Payload): Promise<number> {
  let invalid = 0
  const sampleIds: string[] = []
  await forEachDoc(payload, 'skill-installs', (doc) => {
    if (doc.status !== 'installed' || doc.runner) return
    invalid++
    if (sampleIds.length < 8) sampleIds.push(String(doc.id))
  })

  if (invalid > 0) {
    payload.logger.error(
      `SkillInstalls installed 状态存在 runner=NULL：count=${invalid} sampleIds=${sampleIds.join(',')}`,
    )
  } else {
    payload.logger.info('SkillInstalls installed 记录 Runner 绑定：OK')
  }
  return invalid
}

async function main() {
  const startupIssues = checkStartupEnv()
  for (const issue of startupIssues) {
    const line = `启动配置预检${issue.level === 'blocker' ? '失败' : '警告'} [${issue.code}] ${issue.message}`
    if (issue.level === 'blocker') console.error(line)
    else console.warn(line)
  }
  const startupBlockers = countBlockers(startupIssues)
  if (startupBlockers > 0) {
    console.error(`启动配置预检失败：发现 ${startupBlockers} 个基础阻断项；未继续连接数据库`)
    process.exit(2)
  }

  const payload = await getPayload({ config })
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const envIssues = checkProductionEnv(runtimeEnv)
  for (const issue of envIssues) {
    const line = `生产配置预检${issue.level === 'blocker' ? '失败' : '警告'} [${issue.code}] ${issue.message}`
    if (issue.level === 'blocker') console.error(line)
    else console.warn(line)
  }
  const envBlockers = countBlockers(envIssues)
  if (envBlockers > 0) {
    console.error(`生产上线预检失败：发现 ${envBlockers} 个配置阻断项；请先在后台「部署设置」或 env 中补齐`)
    process.exit(2)
  }

  let liveBlockers = 0
  try {
    const checks = await runNewApiPermissionProbe({
      baseUrl: runtimeEnv.NEWAPI_ADMIN_BASE_URL,
      key: runtimeEnv.NEWAPI_ADMIN_KEY,
      userId: runtimeEnv.NEWAPI_ADMIN_USER_ID,
      bearer: runtimeEnv.NEWAPI_AUTH_BEARER === '1',
      subGroup: runtimeEnv.NEWAPI_SUB_GROUP || '',
    })
    const { tokenOK, logOK, logFilterOK, logTimeFilterOK, logSettlementOK, pricingOK, statusOK, hint } =
      classifyNewApiProbe(checks)
    for (const c of checks) {
      const level = c.ok ? '通过' : '失败'
      const message = c.message ? ` message=${c.message}` : ''
      const settlement = c.ambiguousSettlementCount ? ` ambiguousSettlement=${c.ambiguousSettlementCount}` : ''
      console[c.ok ? 'log' : 'error'](
        `New API 在线预检${level}: path=${c.path} status=${c.status} shape=${c.shape}${settlement}${message}`,
      )
    }
    if (!tokenOK) liveBlockers++
    const usageSource = runtimeEnv.NEWAPI_USAGE_SOURCE === 'local' ? 'local' : 'newapi'
    if (!logOK && usageSource === 'newapi') liveBlockers++
    if (logOK && !logFilterOK && usageSource === 'newapi') liveBlockers++
    if (logOK && logFilterOK && !logTimeFilterOK && usageSource === 'newapi') liveBlockers++
    if (logOK && logFilterOK && logTimeFilterOK && !logSettlementOK && usageSource === 'newapi') liveBlockers++
    if (logOK && logFilterOK && logTimeFilterOK && logSettlementOK && !pricingOK && usageSource === 'newapi') liveBlockers++
    if (logOK && logFilterOK && logTimeFilterOK && logSettlementOK && pricingOK && !statusOK && usageSource === 'newapi') liveBlockers++
    if (!logOK && usageSource === 'local') {
      console.warn('New API /api/log 权限不足；当前 NEWAPI_USAGE_SOURCE=local，仅因已显式确认 local 估算才不阻断')
    }
    if (!tokenOK || !logOK || !logFilterOK || !logTimeFilterOK || !logSettlementOK || !pricingOK || !statusOK) {
      console.error(hint)
    }
  } catch (e) {
    liveBlockers++
    console.error(`New API 在线预检失败：${redactNewApiProbeText((e as Error).message, [runtimeEnv.NEWAPI_ADMIN_KEY || ''])}`)
  }
  if (liveBlockers > 0) {
    console.error(`生产上线预检失败：发现 ${liveBlockers} 个 New API 在线阻断项；未继续数据重复检查`)
    process.exit(2)
  }

  payload.logger.info('生产上线预检启动：配置已通过，继续检查唯一约束上线前的数据重复')

  let blockers = 0
  for (const spec of SPECS) blockers += await checkDuplicates(payload, spec)
  blockers += await checkInstalledRecordsHaveRunner(payload)

  if (blockers > 0) {
    payload.logger.error(`生产上线预检失败：发现 ${blockers} 组数据阻断项；请先按总纲清理，再跑 migration`)
    process.exit(2)
  }

  payload.logger.info('生产上线预检通过：可继续执行 schema migration')
  process.exit(0)
}

main().catch((e) => {
  console.error('生产上线预检失败：', e)
  process.exit(1)
})
