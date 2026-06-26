import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'
import { SEED_SKILLS } from './skills'

// Hengshu Skill Spec v1 非破坏性迁移：
// - 官方 Skill（按 slug 匹配 SEED_SKILLS）：套用拆分后的 system/user 模板 + 示例
// - 其它 Skill：整段 promptTemplate 保留为 user 模板，systemPrompt 留空（运行行为不变）
// - 所有版本补 license / minRunnerVersion / permissions 默认值
async function migrate() {
  const payload = await getPayload({ config })
  const bySlug = Object.fromEntries(SEED_SKILLS.map((s) => [s.slug, s]))

  const versions = await payload.find({
    collection: 'skill-versions',
    limit: 1000,
    depth: 1,
    overrideAccess: true,
  })

  let updated = 0
  for (const v of versions.docs as any[]) {
    const skill =
      typeof v.skill === 'object'
        ? v.skill
        : await payload.findByID({ collection: 'skills', id: v.skill, overrideAccess: true }).catch(() => null)
    const seed = skill ? bySlug[skill.slug] : undefined

    const data: any = {
      license: v.license || 'CC-BY-NC-4.0',
      minRunnerVersion: v.minRunnerVersion || '0.2.0',
      permissions: v.permissions || {
        network: false,
        fileRead: false,
        fileWrite: false,
        shell: false,
      },
    }
    if (seed) {
      data.systemPrompt = seed.systemPrompt
      data.promptTemplate = seed.promptTemplate
      data.examples = seed.examples || []
    } else if (!v.systemPrompt) {
      data.systemPrompt = ''
    }

    await payload.update({ collection: 'skill-versions', id: v.id, data, overrideAccess: true })
    updated++
  }

  payload.logger.info(`Spec v1 迁移完成：${updated} 个版本`)
  process.exit(0)
}

migrate().catch((e) => {
  console.error('迁移失败：', e)
  process.exit(1)
})
