import type { CollectionConfig } from 'payload'
import { isAdmin, isLoggedIn, ownerOrAdmin } from '@/access'
import { awardContribution } from '@/lib/contribution'

export const Bounties: CollectionConfig = {
  slug: 'bounties',
  labels: { singular: '悬赏', plural: '悬赏' },
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'status', 'rewardType', 'rewardPoints', 'creator', 'dueAt'],
    group: 'Skill 内容',
  },
  access: {
    read: () => true,
    create: isLoggedIn,
    update: ownerOrAdmin('creator'),
    delete: isAdmin,
  },
  fields: [
    { name: 'title', type: 'text', required: true, label: '标题' },
    { name: 'description', type: 'textarea', label: '需求说明' },
    {
      name: 'creator',
      type: 'relationship',
      relationTo: 'users',
      label: '发布人',
      admin: { readOnly: true },
    },
    {
      name: 'rewardType',
      type: 'select',
      defaultValue: 'points',
      label: '赏金类型',
      options: [
        { label: '贡献值', value: 'points' },
        { label: '现金', value: 'cash' },
        { label: '平台额度', value: 'credit' },
      ],
    },
    { name: 'rewardPoints', type: 'number', defaultValue: 0, label: '贡献值赏金' },
    { name: 'rewardAmount', type: 'number', defaultValue: 0, label: '现金赏金' },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'open',
      label: '状态',
      options: [
        { label: '开放中', value: 'open' },
        { label: '已接单', value: 'accepted' },
        { label: '已提交', value: 'submitted' },
        { label: '已完成', value: 'completed' },
        { label: '争议中', value: 'disputed' },
        { label: '已取消', value: 'cancelled' },
      ],
    },
    {
      name: 'frozenPoints',
      type: 'number',
      defaultValue: 0,
      label: '冻结术值',
      admin: { readOnly: true, description: '发布时从发布人冻结，完成后发给接单人' },
    },
    { name: 'acceptedBy', type: 'relationship', relationTo: 'users', label: '接单人' },
    { name: 'submittedSkill', type: 'relationship', relationTo: 'skills', label: '提交的 Skill' },
    {
      name: 'requirements',
      type: 'json',
      label: '要求（场景/输入输出/模型/验收标准）',
    },
    { name: 'dueAt', type: 'date', label: '截止时间' },
    { name: 'isPublic', type: 'checkbox', defaultValue: true, label: '公开' },
  ],
  hooks: {
    beforeChange: [
      async ({ data, req, operation }) => {
        if (operation === 'create') {
          if (req.user && !data.creator) data.creator = req.user.id
          // 冻结术值赏金：校验发布人余额
          if (data.rewardType === 'points' && (data.rewardPoints || 0) > 0) {
            const creator = await req.payload
              .findByID({ collection: 'users', id: data.creator, overrideAccess: true, depth: 0, req })
              .catch(() => null)
            if (!creator || (creator.contributionScore || 0) < data.rewardPoints) {
              throw new Error('术值不足，无法冻结悬赏赏金')
            }
            data.frozenPoints = data.rewardPoints
          }
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        // 发布即冻结：从发布人扣除 frozenPoints（记一条 consume 流水）
        if (operation === 'create' && (doc.frozenPoints || 0) > 0) {
          const creatorId = typeof doc.creator === 'object' ? doc.creator?.id : doc.creator
          await awardContribution(req.payload, {
            userId: creatorId,
            actionType: 'consume',
            points: -doc.frozenPoints,
            relatedBounty: doc.id,
            description: `冻结悬赏赏金「${doc.title}」`,
            req,
          })
        }
        return doc
      },
    ],
  },
}
