import type { CollectionConfig } from 'payload'
import { isAdmin } from '@/access'
import { CONTRIBUTION_ACTIONS } from '@/lib/constants'

// 术值规则（可配置）。awardContribution 据此取分值并做反作弊（日上限/自操作排除）。
export const ContributionRules: CollectionConfig = {
  slug: 'contribution-rules',
  labels: { singular: '术值规则', plural: '术值规则' },
  admin: {
    useAsTitle: 'actionType',
    defaultColumns: ['actionType', 'basePoints', 'dailyLimit', 'selfActionExcluded', 'enabled'],
    group: '成员管理',
  },
  access: {
    read: isAdmin,
    create: isAdmin,
    update: isAdmin,
    delete: isAdmin,
  },
  fields: [
    {
      name: 'actionType',
      type: 'select',
      required: true,
      unique: true,
      index: true,
      label: '行为',
      options: CONTRIBUTION_ACTIONS.map((a) => ({ label: a, value: a })),
    },
    { name: 'basePoints', type: 'number', required: true, defaultValue: 0, label: '基础术值' },
    {
      name: 'dailyLimit',
      type: 'number',
      defaultValue: 0,
      label: '每日上限(次)',
      admin: { description: '每用户每日该行为发放次数上限，0=不限' },
    },
    { name: 'selfActionExcluded', type: 'checkbox', defaultValue: false, label: '排除自操作' },
    { name: 'enabled', type: 'checkbox', defaultValue: true, label: '启用' },
    { name: 'description', type: 'text', label: '说明' },
  ],
}
