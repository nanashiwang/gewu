import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'
import { SKILL_CATEGORIES } from '../lib/constants'
import { SEED_SKILLS } from './skills'
import { shouldCreateWelcomeInvite } from './security'

async function seed() {
  const payload = await getPayload({ config })
  payload.logger.info('开始注入种子数据…')

  // ── 管理员（官方 Skill 作者）──
  // 只复用真实首管；没有管理员时不再创建默认 admin@gewu.example，避免抢占“首个注册账号即管理员”规则。
  const admin = (
    await payload.find({
      collection: 'users',
      where: { role: { equals: 'admin' } },
      limit: 1,
      sort: 'createdAt',
      overrideAccess: true,
    })
  ).docs[0]
  if (!admin) {
    throw new Error('未找到管理员。请先通过注册/后台创建第一个账号；系统会自动把首个用户设为管理员，然后再运行 seed。')
  }
  payload.logger.info(`· 复用现有管理员作为官方 Skill 作者：${admin.email}`)

  // ── 分类 ──
  const catMap: Record<string, string> = {}
  for (const c of SKILL_CATEGORIES) {
    let cat = (
      await payload.find({
        collection: 'categories',
        where: { slug: { equals: c.slug } },
        limit: 1,
        overrideAccess: true,
      })
    ).docs[0]
    if (!cat) {
      cat = await payload.create({
        collection: 'categories',
        overrideAccess: true,
        data: { name: c.name, slug: c.slug, icon: c.icon },
      })
    }
    catMap[c.slug] = cat.id as string
  }
  payload.logger.info(`✓ 分类就绪（${Object.keys(catMap).length} 个）`)

  // ── 官方 Skill ──
  for (const s of SEED_SKILLS) {
    const exists = (
      await payload.find({
        collection: 'skills',
        where: { slug: { equals: s.slug } },
        limit: 1,
        overrideAccess: true,
      })
    ).docs[0]
    if (exists) {
      const patch: Record<string, boolean | string | null> = {}
      if (Boolean((exists as any).isEssential) !== Boolean(s.essential)) patch.isEssential = Boolean(s.essential)
      if (((exists as any).essentialReason || null) !== (s.essentialReason || null)) {
        patch.essentialReason = s.essentialReason || null
      }
      if (Boolean((exists as any).isFeatured) !== Boolean(s.featured)) patch.isFeatured = Boolean(s.featured)
      if (Object.keys(patch).length > 0) {
        await payload.update({
          collection: 'skills',
          id: exists.id,
          data: patch,
          overrideAccess: true,
        })
        payload.logger.info(`· 更新已存在 Skill 标记：${s.slug}`)
      }
      payload.logger.info(`· 跳过已存在 Skill：${s.slug}`)
      continue
    }
    const skill = await payload.create({
      collection: 'skills',
      overrideAccess: true,
      data: {
        title: s.title,
        slug: s.slug,
        description: s.description,
        category: catMap[s.category],
        author: admin.id,
        visibility: 'public',
        status: 'published',
        isOfficial: true,
        isEssential: !!s.essential,
        essentialReason: s.essentialReason || undefined,
        isFeatured: !!s.featured,
      },
    })
    const version = await payload.create({
      collection: 'skill-versions',
      overrideAccess: true,
      data: {
        skill: skill.id,
        version: '1.0.0',
        status: 'active',
        createdBy: admin.id,
        systemPrompt: s.systemPrompt,
        promptTemplate: s.promptTemplate,
        inputSchema: s.inputSchema,
        outputSchema: s.outputSchema,
        recommendedModels: s.recommendedModels,
        routePolicy: s.routePolicy,
        license: s.license,
        examples: s.examples || [],
        changelog: '初始版本',
      },
    })
    await payload.update({
      collection: 'skills',
      id: skill.id,
      overrideAccess: true,
      data: { currentVersion: version.id },
    })
    payload.logger.info(`✓ Skill 已创建：${s.title}`)
  }

  // ── 开发测试邀请码 ──
  if (shouldCreateWelcomeInvite()) {
    let invite = (
      await payload.find({
        collection: 'invite-codes',
        where: { code: { equals: 'WELCOME1' } },
        limit: 1,
        overrideAccess: true,
      })
    ).docs[0]
    if (!invite) {
      invite = await payload.create({
        collection: 'invite-codes',
        overrideAccess: true,
        data: { code: 'WELCOME1', inviter: admin.id, status: 'unused' },
      })
      payload.logger.info('✓ 开发测试邀请码：WELCOME1')
    }
  } else {
    payload.logger.info('· 生产环境跳过固定测试邀请码 WELCOME1')
  }

  payload.logger.info('种子完成 ✅')
  process.exit(0)
}

seed().catch((e) => {
  console.error('种子失败：', e)
  process.exit(1)
})
