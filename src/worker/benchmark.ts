import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'
import { benchmarkSkill } from '../lib/benchmark'
import { modelGatewayConfigured, resolveRuntimeEnv } from '../lib/deploymentSettings'

// 发布即评测(#8) worker：对指定 Skill(或全部已发布)跑系统评测播种初始数据 + LocalScore。
// 用法：npm run worker:benchmark <slug>            # 单个
//      npm run worker:benchmark -- --all           # 全部已发布(谨慎，按模型×样例产生真实 API 成本)
//      npm run worker:benchmark <slug> --models deepseek-chat,glm-4
// ⚠️ 需配 MODEL_GATEWAY_BASE_URL + MODEL_GATEWAY_KEY 才产真实数据；否则走 mock(仅演示，不写报告)。
async function run() {
  const argv = process.argv.slice(2)
  const all = argv.includes('--all')
  const modelsFlagIdx = argv.indexOf('--models')
  const models = modelsFlagIdx >= 0 ? (argv[modelsFlagIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const slug = argv.find((a) => !a.startsWith('--') && a !== (models ? argv[modelsFlagIdx + 1] : ''))

  if (!all && !slug) {
    console.error('用法：npm run worker:benchmark <slug> [--models a,b] | -- --all')
    process.exit(1)
  }

  const payload = await getPayload({ config })
  const runtimeEnv = await resolveRuntimeEnv(payload)
  if (!modelGatewayConfigured(runtimeEnv)) {
    payload.logger.warn('未配置模型网关（后台部署设置或 env），将走 mock/失败保护，不产生真实评测数据')
  }

  const where: any = all
    ? { status: { equals: 'published' } }
    : { slug: { equals: slug } }
  const { docs } = await payload.find({ collection: 'skills', where, depth: 1, limit: all ? 1000 : 1, overrideAccess: true })
  if (docs.length === 0) {
    payload.logger.error(all ? '无已发布 Skill' : `未找到 Skill: ${slug}`)
    process.exit(1)
  }

  for (const skill of docs as any[]) {
    // 解析当前版本
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
    if (!version) {
      payload.logger.warn(`跳过 ${skill.slug}：无可用版本`)
      continue
    }
    const r = await benchmarkSkill(payload, { skill, version, models })
    payload.logger.info(
      `评测 ${skill.slug}：模型[${r.models.join(',')}] × ${r.inputs}样例 = ${r.attempted}次，真实${r.reported}/mock${r.mocked}，LocalScore→${r.localScore}`,
    )
  }
  payload.logger.info('发布即评测完成')
  process.exit(0)
}

run().catch((e) => {
  console.error('发布即评测失败：', e)
  process.exit(1)
})
