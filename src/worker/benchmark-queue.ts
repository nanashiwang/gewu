import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'
import { benchmarkSkill } from '../lib/benchmark'
import { modelGatewayConfigured, resolveRuntimeEnv } from '../lib/deploymentSettings'
import {
  dequeueBenchmarkJobWithClient,
  getBenchmarkRedisClient,
  releaseBenchmarkDedupeWithClient,
  type BenchmarkJob,
} from '../lib/benchmarkQueue'

const DEFAULT_MAX_JOBS = 10
const DEFAULT_MAX_ATTEMPTS = 8

async function loadSkillAndVersion(payload: any, job: BenchmarkJob): Promise<{ skill: any; version: any } | null> {
  const skill = await payload.findByID({
    collection: 'skills',
    id: job.skillId,
    depth: 1,
    overrideAccess: true,
  }).catch(() => null)
  if (!skill || skill.status !== 'published') return null

  let version: any = skill.currentVersion
  if (!version || typeof version === 'string') {
    const vs = await payload.find({
      collection: 'skill-versions',
      where: { skill: { equals: skill.id } },
      sort: '-createdAt',
      limit: 1,
      overrideAccess: true,
    })
    version = vs.docs[0]
  }
  if (!version) return null
  return { skill, version }
}

async function main() {
  const payload = await getPayload({ config })
  const client = await getBenchmarkRedisClient()
  if (!client) {
    payload.logger.warn('REDIS_URL 未配置，benchmark 队列 worker 跳过')
    process.exit(0)
  }
  const runtimeEnv = await resolveRuntimeEnv(payload)
  if (!modelGatewayConfigured(runtimeEnv)) {
    payload.logger.warn('未配置模型网关（后台部署设置或 env），benchmark 会走 mock/失败保护，不产生真实评测数据')
  }
  const maxJobs = Math.max(1, Number(runtimeEnv.BENCHMARK_QUEUE_MAX_JOBS || DEFAULT_MAX_JOBS))
  const maxAttempts = Math.max(1, Number(runtimeEnv.BENCHMARK_MAX_ATTEMPTS_PER_SKILL || DEFAULT_MAX_ATTEMPTS))
  const models = runtimeEnv.BENCHMARK_MODELS?.split(',').map((s) => s.trim()).filter(Boolean)

  let processed = 0
  let skipped = 0
  let failed = 0
  for (let i = 0; i < maxJobs; i++) {
    const job = await dequeueBenchmarkJobWithClient(client)
    if (!job) break

    const loaded = await loadSkillAndVersion(payload, job)
    if (!loaded) {
      skipped++
      await releaseBenchmarkDedupeWithClient(client, job.skillId).catch(() => undefined)
      payload.logger.warn(`benchmark 队列跳过 skill=${job.skillId}：未发布或无版本`)
      continue
    }

    try {
      const r = await benchmarkSkill(payload, {
        skill: loaded.skill,
        version: loaded.version,
        models,
        maxAttempts,
      })
      processed++
      payload.logger.info(
        `队列评测 ${loaded.skill.slug}: attempts=${r.attempted}/${maxAttempts} models=[${r.models.join(',')}] real=${r.reported} mock=${r.mocked} LocalScore=${r.localScore}`,
      )
    } catch (e) {
      failed++
      // 失败释放去重，方便下一轮重新入队/手动补跑；成功保留 24h 去重，防发布钩子抖动重复烧钱。
      await releaseBenchmarkDedupeWithClient(client, job.skillId).catch(() => undefined)
      payload.logger.error(`队列评测失败 skill=${job.skillId}: ${(e as Error).message}`)
    }
  }

  payload.logger.info(`benchmark 队列完成：处理 ${processed}，跳过 ${skipped}，失败 ${failed}`)
  process.exit(failed > 0 ? 2 : 0)
}

main().catch((e) => {
  console.error('benchmark 队列 worker 失败：', e)
  process.exit(1)
})
