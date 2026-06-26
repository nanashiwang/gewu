import type { CollectionConfig } from 'payload'
import { isAdmin, isLoggedIn, ownerOrAdmin } from '@/access'

export const Bounties: CollectionConfig = {
  slug: 'bounties',
  labels: { singular: '悬赏', plural: '悬赏' },
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'status', 'rewardType', 'rewardPoints', 'creator', 'dueAt'],
    group: '用户与社区',
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
        { label: '已取消', value: 'cancelled' },
      ],
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
      ({ data, req, operation }) => {
        if (operation === 'create' && req.user && !data.creator) data.creator = req.user.id
        return data
      },
    ],
  },
}
