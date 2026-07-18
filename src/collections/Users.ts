import type { CollectionConfig } from 'payload'
import { APIError } from 'payload'
import { adminOrSelf, fieldAdminOrSelf, isActiveAccount, isAdmin, isAdminField } from '@/access'
import { normalizeNewApiKeyForStorage } from '@/lib/userSecrets'
import { rowActionsField } from './fields/rowActions'

const siteUrlForCookies = process.env.NEXT_PUBLIC_SERVER_URL || process.env.SERVER_URL || ''
const secureCookies = siteUrlForCookies.startsWith('https://')

export const Users: CollectionConfig = {
  slug: 'users',
  labels: { singular: '用户', plural: '用户' },
  auth: {
    tokenExpiration: 7 * 24 * 60 * 60, // 7 天
    maxLoginAttempts: 5,
    lockTime: 10 * 60 * 1000,
    cookies: { sameSite: 'Lax', secure: secureCookies },
  },
  admin: {
    useAsTitle: 'username',
    defaultColumns: ['username', 'email', 'role', 'level', 'contributionScore', 'rowActions'],
    group: '成员管理',
  },
  access: {
    // 仅管理/审核员可进入后台面板；普通用户与创作者走前台
    admin: ({ req: { user } }) =>
      Boolean(isActiveAccount(user) && ['admin', 'reviewer', 'enterprise_admin'].includes(user.role as string)),
    read: adminOrSelf,
    create: isAdmin, // 首个用户由 Payload 引导流程创建；其余经邀请码端点(overrideAccess)或管理员
    update: adminOrSelf,
    delete: isAdmin,
  },
  fields: [
    rowActionsField('users'),
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
      name: 'accountStatus',
      type: 'select',
      defaultValue: 'active',
      label: '账号状态',
      index: true,
      access: { update: isAdminField },
      admin: { description: 'banned = 禁止登录且冻结一切经济操作（挣分/兑换/运行）' },
      options: [
        { label: '正常', value: 'active' },
        { label: '封禁', value: 'banned' },
      ],
    },
    {
      name: 'contributionScore',
      type: 'number',
      defaultValue: 0,
      index: true, // 贡献榜 sort -contributionScore 热路径
      label: '贡献值',
      access: { create: () => false, update: () => false },
      admin: { description: '权威值，恒等于 contribution-logs 之和；仅服务端事务/对账 worker 写入' },
    },
    {
      name: 'consumptionScore',
      type: 'number',
      defaultValue: 0,
      label: '消耗值',
      access: { create: () => false, update: () => false },
      admin: { description: '派生/历史指标，禁止后台手改' },
    },
    {
      name: 'creditBalance',
      type: 'number',
      defaultValue: 0,
      label: 'credit 余额（算力燃料）',
      access: { create: () => false, update: () => false },
      admin: { description: '1 credit = ¥0.01 零售。权威值，恒等于 credit-logs 之和；仅服务端事务写入' },
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
      name: 'ipHash',
      type: 'text',
      index: true,
      label: '注册 IP 哈希（反女巫）',
      access: { read: isAdminField },
      admin: { readOnly: true, hidden: true },
    },
    {
      name: 'deviceHash',
      type: 'text',
      index: true,
      label: '设备哈希（反女巫）',
      access: { read: isAdminField },
      admin: { readOnly: true, hidden: true },
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
      // BYOK_DIRECT_FIELD_ACCESS_BLOCKED: 只允许服务端设置接口 overrideAccess 写入，避免后台/REST 直写明文或读出密文。
      access: { read: () => false, create: () => false, update: () => false },
      admin: {
        hidden: true,
        readOnly: true,
        description: '服务端 AES-GCM 加密存储；仅 /v1/me/settings 可写，不在后台或 REST 回显',
        position: 'sidebar',
      },
    },
  ],
  hooks: {
    beforeLogin: [
      ({ user }) => {
        // 封禁账号禁止登录（active session 的经济操作另由端点 accountStatus 校验拦截）
        if ((user as any)?.accountStatus === 'banned') {
          throw new APIError('账号已被封禁', 403)
        }
      },
    ],
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
        if (data && Object.prototype.hasOwnProperty.call(data, 'newapiKeyEncrypted')) {
          const userData = data as Record<string, unknown>
          const normalized = normalizeNewApiKeyForStorage(userData.newapiKeyEncrypted)
          if (typeof normalized !== 'undefined') {
            userData.newapiKeyEncrypted = normalized
          }
        }
        return data
      },
    ],
    beforeDelete: [
      async ({ id, req }) => {
        // 删用户级联（在删除事务内、透传 req → 原子；任一步失败整体回滚，绝不产生脏数据）
        const p = req.payload
        const opts = { overrideAccess: true, req }
        // 阻断危险场景：仍有作品(会悬空作者) / 进行中或争议悬赏(冻结贡献值会卡死)
        const skills = await p.count({ collection: 'skills', where: { author: { equals: id } }, ...opts })
        if (skills.totalDocs > 0) throw new Error('该用户仍有 Skill 作品，请先转移或删除其作品后再删账号')
        const relaySites = await p.count({ collection: 'relay-sites' as any, where: { owner: { equals: id } }, ...opts })
        if (relaySites.totalDocs > 0) throw new Error('该用户仍有中转站，请先转移或删除中转站后再删账号')
        const activeBounties = await p.count({
          collection: 'bounties',
          where: {
            and: [
              { or: [{ creator: { equals: id } }, { acceptedBy: { equals: id } }] },
              { status: { in: ['open', 'accepted', 'submitted', 'disputed'] } },
            ],
          },
          ...opts,
        })
        if (activeBounties.totalDocs > 0) throw new Error('该用户有进行中/争议中的悬赏，请先结算或取消后再删账号')
        // 阻断资金蒸发：credit 是真金（¥），余额非 0 时删账号会静默丢钱且留悬空流水，必须先退款/清零
        const u = await p.findByID({ collection: 'users', id, depth: 0, ...opts }).catch(() => null)
        if (u && Math.abs((u as any).creditBalance || 0) > 1e-9) {
          throw new Error('该用户 credit 余额非 0，请先退款或清零后再删账号')
        }
        const creditLogs = await p.count({ collection: 'credit-logs', where: { user: { equals: id } }, ...opts })
        if (creditLogs.totalDocs > 0) throw new Error('该用户存在 credit 流水，按资金台账留痕要求禁止删号；请封禁或匿名化')
        const contributionLogs = await p.count({ collection: 'contribution-logs', where: { user: { equals: id } }, ...opts })
        if (contributionLogs.totalDocs > 0) throw new Error('该用户存在贡献值流水，按台账留痕要求禁止删号；请封禁或匿名化')
        // 删除用户私有从属记录（favorites/reviews 触发各自 afterDelete 修正 Skill 计数）
        for (const collection of [
          'favorites',
          'reviews',
          'skill-installs',
          'runner-clients',
          'device-codes',
        ] as const) {
          await p.delete({ collection, where: { user: { equals: id } }, ...opts })
        }
        await p.delete({ collection: 'invite-codes', where: { inviter: { equals: id } }, ...opts })
        // 解除可保留数据里的用户引用（保留历史、避免外键阻断删除）
        await p.update({ collection: 'skill-runs', where: { user: { equals: id } }, data: { user: null }, ...opts })
        await p.update({ collection: 'bounties', where: { creator: { equals: id } }, data: { creator: null }, ...opts })
        await p.update({ collection: 'bounties', where: { acceptedBy: { equals: id } }, data: { acceptedBy: null }, ...opts })
        await p.update({ collection: 'users', where: { invitedBy: { equals: id } }, data: { invitedBy: null }, ...opts })
        await p.update({ collection: 'invite-codes', where: { usedBy: { equals: id } }, data: { usedBy: null }, ...opts })
        await p.update({ collection: 'reports', where: { reporter: { equals: id } }, data: { reporter: null }, ...opts })
        await p.update({ collection: 'reports', where: { handledBy: { equals: id } }, data: { handledBy: null }, ...opts })
        await p.update({ collection: 'skill-versions', where: { createdBy: { equals: id } }, data: { createdBy: null }, ...opts })
      },
    ],
  },
}
