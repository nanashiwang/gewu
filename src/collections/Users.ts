import type { CollectionConfig } from 'payload'
import { adminOrSelf, fieldAdminOrSelf, isAdmin, isAdminField } from '@/access'

export const Users: CollectionConfig = {
  slug: 'users',
  labels: { singular: '用户', plural: '用户' },
  auth: {
    tokenExpiration: 7 * 24 * 60 * 60, // 7 天
    maxLoginAttempts: 5,
    lockTime: 10 * 60 * 1000,
    cookies: { sameSite: 'Lax' },
  },
  admin: {
    useAsTitle: 'username',
    defaultColumns: ['username', 'email', 'role', 'level', 'contributionScore'],
    group: '用户与社区',
  },
  access: {
    read: adminOrSelf,
    create: isAdmin, // 首个用户由 Payload 引导流程创建；其余经邀请码端点(overrideAccess)或管理员
    update: adminOrSelf,
    delete: isAdmin,
  },
  fields: [
    { name: 'username', type: 'text', required: true, unique: true, label: '用户名' },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'user',
      label: '角色',
      access: { update: isAdminField },
      options: [
        { label: '普通用户', value: 'user' },
        { label: '创作者', value: 'creator' },
        { label: '认证创作者', value: 'certified_creator' },
        { label: '审核员', value: 'reviewer' },
        { label: '管理员', value: 'admin' },
        { label: '企业管理员', value: 'enterprise_admin' },
      ],
    },
    { name: 'level', type: 'number', defaultValue: 1, label: '等级' },
    {
      name: 'contributionScore',
      type: 'number',
      defaultValue: 0,
      label: '贡献值',
      access: { update: isAdminField },
    },
    {
      name: 'consumptionScore',
      type: 'number',
      defaultValue: 0,
      label: '消耗值',
      access: { update: isAdminField },
    },
    {
      name: 'ratioScore',
      type: 'number',
      virtual: true,
      label: '贡献比',
      admin: { readOnly: true },
      hooks: {
        afterRead: [
          ({ data }) => {
            const c = (data?.contributionScore as number) || 0
            const u = (data?.consumptionScore as number) || 0
            return u > 0 ? Math.round((c / u) * 100) / 100 : c
          },
        ],
      },
    },
    { name: 'inviteCount', type: 'number', defaultValue: 3, label: '可用邀请码数' },
    {
      name: 'warningCount',
      type: 'number',
      defaultValue: 0,
      label: '违规次数',
      access: { update: isAdminField },
    },
    { name: 'bio', type: 'textarea', label: '简介' },
    {
      name: 'invitedBy',
      type: 'relationship',
      relationTo: 'users',
      label: '邀请人',
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'newapiUserId',
      type: 'text',
      label: '模型网关 用户 ID',
      access: { read: fieldAdminOrSelf },
    },
    {
      name: 'newapiKeyEncrypted',
      type: 'text',
      label: '模型网关 Key',
      access: { read: fieldAdminOrSelf, update: fieldAdminOrSelf },
      admin: {
        description: 'MVP 阶段服务端保存；生产需加密存储',
        position: 'sidebar',
      },
    },
  ],
  hooks: {
    beforeChange: [
      async ({ req, operation, data }) => {
        // 第一个创建的用户自动成为超级管理员
        if (operation === 'create') {
          const { totalDocs } = await req.payload.count({
            collection: 'users',
            overrideAccess: true,
            req,
          })
          if (totalDocs === 0) {
            data.role = 'admin'
            data.level = 99
            if (data.inviteCount == null) data.inviteCount = 10
          }
        }
        return data
      },
    ],
  },
}
