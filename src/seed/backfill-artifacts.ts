import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'
import { ensureArtifact } from '../lib/artifacts'

// 为现有全部 Skill 版本冻结 yaml + json 制品（幂等，可重复跑）
async function run() {
  const payload = await getPayload({ config })
  const versions = await payload.find({
    collection: 'skill-versions',
    limit: 1000,
    depth: 0,
    overrideAccess: true,
  })

  let n = 0
  for (const v of versions.docs as any[]) {
    const skillId = typeof v.skill === 'object' ? v.skill.id : v.skill
    const skill = await payload
      .findByID({ collection: 'skills', id: skillId, depth: 2, overrideAccess: true })
      .catch(() => null)
    if (!skill) continue
    await ensureArtifact(payload, skill, v, 'yaml')
    await ensureArtifact(payload, skill, v, 'json')
    n++
  }

  payload.logger.info(`制品回填完成：${n} 个版本 × 2 格式`)
  process.exit(0)
}

run().catch((e) => {
  console.error('回填失败：', e)
  process.exit(1)
})
