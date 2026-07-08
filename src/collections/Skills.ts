import type { CollectionConfig } from 'payload'
import { isActiveAccount, isAdmin, isCreatorOrAbove, publishedOrPrivileged } from '@/access'
import { slugify } from '@/lib/slug'
import { awardContribution } from '@/lib/contribution'
import { enqueueBenchmarkJob } from '@/lib/benchmarkQueue'
import { refreshSkillPassport } from '@/lib/passportRefresh'
import { notifySkillSubscribers, shouldNotifySkillVersionUpdate } from '@/lib/skillSubscriberNotifications'
import { normalizeSkillSubmissionVisibility } from '@/lib/skillVisibility'
import { rowActionsField } from './fields/rowActions'

export const Skills: CollectionConfig = {
  slug: 'skills',
  labels: { singular: 'Skill', plural: 'Skill' },
  // 市场/排行热路径：where status+visibility，sort -skillRank/-runCount/-successRate（各字段已单列索引）
  indexes: [
    { fields: ['status', 'visibility'] },
    { fields: ['status', 'visibility', 'isEssential'] },
  ],
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'status', 'author', 'skillRank', 'runCount', 'successRate', 'rowActions'],
    group: 'Skill 内容',
  },
  access: {
    read: publishedOrPrivileged,
    create: isCreatorOrAbove,
    update: ({ req: { user } }) => {
      if (!isActiveAccount(user)) return false
      if (user.role === 'admin' || user.role === 'reviewer') return true
      return { author: { equals: user.id } }
    },
    delete: isAdmin,
  },
  fields: [
    { name: 'title', type: 'text', required: true, label: '名称' },
    {
      name: 'slug',
      type: 'text',
      unique: true,
      index: true,
      label: 'Slug',
      admin: { position: 'sidebar' },
    },
    { name: 'description', type: 'textarea', label: '简介' },
    {
      name: 'clientSubmissionKey',
      type: 'text',
      unique: true,
      index: true,
      label: '客户端提交幂等键',
      admin: { hidden: true, readOnly: true },
    },
    { name: 'category', type: 'relationship', relationTo: 'categories', label: '分类' },
    {
      type: 'collapsible',
      label: '来源导入',
      admin: { initCollapsed: true, description: '用于 GitHub/Claude/GPTs 来源同步和变更差分。' },
      fields: [
        { name: 'importSourceFormat', type: 'text', label: '来源格式', admin: { readOnly: true } },
        { name: 'importSourceLocator', type: 'text', label: '来源定位', admin: { readOnly: true } },
        { name: 'importSourceHash', type: 'text', index: true, label: '来源内容 Hash', admin: { readOnly: true } },
        { name: 'importSourceLastSyncedAt', type: 'date', label: '最近同步时间', admin: { readOnly: true } },
        { name: 'importSourceLastDiff', type: 'json', label: '最近变更差分', admin: { readOnly: true } },
      ],
    },
    {
      name: 'author',
      type: 'relationship',
      relationTo: 'users',
      label: '作者',
      admin: { position: 'sidebar' },
    },
    {
      name: 'forkedFrom',
      type: 'relationship',
      relationTo: 'skills',
      index: true,
      label: 'Fork 自',
      admin: { position: 'sidebar', readOnly: true, description: '从哪个 Skill 复制而来（血统，用于变异-表现差分分析）' },
    },
    {
      name: 'visibility',
      type: 'select',
      defaultValue: 'public',
      label: '可见性',
      admin: { position: 'sidebar' },
      options: [
        { label: '公开', value: 'public' },
        { label: '私有', value: 'private' },
        { label: '不公开列出', value: 'unlisted' },
        { label: '企业', value: 'enterprise' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      label: '状态',
      admin: { position: 'sidebar' },
      options: [
        { label: '草稿', value: 'draft' },
        { label: '待审核', value: 'pending' },
        { label: '已发布', value: 'published' },
        { label: '已驳回', value: 'rejected' },
        { label: '已归档', value: 'archived' },
      ],
    },
    {
      name: 'currentVersion',
      type: 'relationship',
      relationTo: 'skill-versions',
      label: '当前版本',
      admin: { position: 'sidebar' },
    },
    // ── 状态标签 ──
    { name: 'isOfficial', type: 'checkbox', defaultValue: false, label: '官方' },
    {
      name: 'isEssential',
      type: 'checkbox',
      defaultValue: false,
      label: '必备',
      admin: { description: '新用户上手第一屏推荐，强调快速尝到甜头。' },
    },
    {
      name: 'essentialReason',
      type: 'textarea',
      label: '必备推荐理由',
      admin: {
        description: '解释为什么适合作为新用户第一跑，会展示在首页、市场和公开 API。',
        condition: (_, siblingData) => Boolean(siblingData?.isEssential),
      },
    },
    { name: 'isFeatured', type: 'checkbox', defaultValue: false, label: '精选' },
    { name: 'isFreeleech', type: 'checkbox', defaultValue: false, label: '限免' },
    // ── 列表行内操作（下架/发布 + 删除）──
    rowActionsField('skills'),
    // ── 健康度/指标（由运行链路与 Worker 维护）──
    {
      type: 'collapsible',
      label: '指标（自动维护）',
      admin: { initCollapsed: true },
      fields: [
        { name: 'skillRank', type: 'number', defaultValue: 0, index: true, label: '可信分' },
        { name: 'localScore', type: 'number', defaultValue: 0, label: '兼容分（本地模型）' },
        { name: 'healthScore', type: 'number', defaultValue: 0, label: '健康度' },
        { name: 'runCount', type: 'number', defaultValue: 0, index: true, label: '调用次数' },
        { name: 'downloadCount', type: 'number', defaultValue: 0, label: '下载次数' },
        { name: 'favoriteCount', type: 'number', defaultValue: 0, label: '收藏数' },
        { name: 'reviewCount', type: 'number', defaultValue: 0, label: '评论数' },
        { name: 'avgRating', type: 'number', defaultValue: 0, label: '平均评分' },
        { name: 'avgCost', type: 'number', defaultValue: 0, label: '平均成本(元)' },
        { name: 'avgLatencyMs', type: 'number', defaultValue: 0, label: '平均耗时(ms)' },
        { name: 'successRate', type: 'number', defaultValue: 0, index: true, label: '成功率(0-1)' },
        { name: 'formatSuccessRate', type: 'number', defaultValue: 0, label: '格式成功率(0-1)' },
        { name: 'lastRunAt', type: 'date', label: '最近调用时间' },
        { name: 'lastUpdatedAt', type: 'date', label: '最近更新时间' },
      ],
    },
  ],
  hooks: {
    beforeDelete: [
      async ({ id, req }) => {
        // 级联清理引用本 Skill 的子记录：这些外键为 SET NULL，但部分子表 skill 为必填(NOT NULL)，
        // 直接删父会触发 NOT NULL 违例(500)。按依赖顺序（先删引用版本的，再删版本）清理。
        const children = [
          'compat-reports',
          'skill-artifacts',
          'skill-runs',
          'skill-versions',
          'skill-installs',
          'favorites',
          'reviews',
        ] as const
        for (const collection of children) {
          await req.payload.delete({
            collection,
            where: { skill: { equals: id } },
            req,
            overrideAccess: true,
          })
        }
      },
    ],
    beforeChange: [
      ({ data, req, operation }) => {
        if (req.user && data.visibility) {
          data.visibility = normalizeSkillSubmissionVisibility(data.visibility, req.user)
        }
        if (operation === 'create') {
          if (!data.slug && data.title) data.slug = slugify(data.title)
          if (!data.author && req.user) data.author = req.user.id
          if (!data.lastUpdatedAt) data.lastUpdatedAt = new Date().toISOString()
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, previousDoc, operation, req }) => {
        if (shouldNotifySkillVersionUpdate({ doc, previousDoc, operation })) {
          const versionId = typeof doc.currentVersion === 'object' ? doc.currentVersion?.id : doc.currentVersion
          const version =
            versionId &&
            (await req.payload
              .findByID({
                collection: 'skill-versions',
                id: versionId,
                overrideAccess: true,
                depth: 0,
                req,
              })
              .catch(() => null))
          notifySkillSubscribers(req.payload, {
            skill: doc,
            version: version || null,
            actorId: req.user?.id,
            req,
          }).catch((e) => req.payload.logger?.error(`Skill 更新订阅通知失败: ${(e as Error).message}`))
        }

        // 发布通过审核：给作者 +50（仅在状态从非 published 变为 published 时）
        const becamePublished =
          doc.status === 'published' &&
          (operation === 'create' || previousDoc?.status !== 'published')
        if (becamePublished) {
          const authorId =
            typeof doc.author === 'object' ? doc.author?.id : doc.author
          if (authorId) {
            // 幂等：每个 Skill 的发布奖励只发一次（idempotencyKey 唯一索引硬保证，根治并发双发竞态）
            await awardContribution(req.payload, {
              userId: authorId,
              actionType: 'skill_published',
              points: 50,
              relatedSkill: doc.id,
              description: `Skill「${doc.title}」发布通过`,
              idempotencyKey: `pub:${doc.id}`,
              req,
            })
          }
          // 发布即评测：只入 Redis 队列，真实跑测由 worker 串行处理并做成本上限控制；入队失败不阻断审核发布。
          enqueueBenchmarkJob(req.payload, { skillId: doc.id, slug: doc.slug, reason: 'published' }).catch((e) =>
            req.payload.logger?.error(`发布即评测入队异常 skill=${doc.id}: ${(e as Error).message}`),
          )
          refreshSkillPassport(req.payload, String(doc.id)).catch((e) =>
            req.payload.logger?.error(`发布后刷新 Skill Passport 失败 skill=${doc.id}: ${(e as Error).message}`),
          )
        }
        return doc
      },
    ],
  },
}
