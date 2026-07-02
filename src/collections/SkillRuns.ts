import type { CollectionConfig } from 'payload'
import { isAdmin, ownerOrAdmin } from '@/access'
import { ROUTE_MODES } from '@/lib/constants'
import { rowActionsField } from './fields/rowActions'

export const SkillRuns: CollectionConfig = {
  slug: 'skill-runs',
  labels: { singular: '运行记录', plural: '运行记录' },
  admin: {
    useAsTitle: 'runId',
    defaultColumns: ['runId', 'skill', 'model', 'success', 'estimatedCost', 'latencyMs', 'createdAt', 'rowActions'],
    group: 'Skill 内容',
  },
  access: {
    read: ownerOrAdmin('user'),
    create: isAdmin, // 仅由运行端点 overrideAccess 写入
    update: isAdmin,
    delete: isAdmin,
  },
  fields: [
    rowActionsField('skill-runs'),
    { name: 'runId', type: 'text', index: true, label: '运行 ID' },
    { name: 'user', type: 'relationship', relationTo: 'users', label: '用户' },
    { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, label: 'Skill' },
    { name: 'skillVersion', type: 'relationship', relationTo: 'skill-versions', label: '版本' },
    { name: 'model', type: 'text', label: '使用模型' },
    {
      name: 'routeMode',
      type: 'select',
      label: '路由模式',
      options: ROUTE_MODES.map((m) => ({ label: m, value: m })),
    },
    { name: 'inputJson', type: 'json', label: '输入' },
    { name: 'outputText', type: 'textarea', label: '输出原文' },
    { name: 'outputJson', type: 'json', label: '结构化输出' },
    { name: 'promptTokens', type: 'number', label: '输入 token' },
    { name: 'completionTokens', type: 'number', label: '输出 token' },
    { name: 'totalTokens', type: 'number', label: '总 token' },
    { name: 'estimatedCost', type: 'number', label: '估算成本(元)' },
    { name: 'chargedAmount', type: 'number', label: '实际收费' },
    { name: 'savedAmount', type: 'number', defaultValue: 0, label: '省钱回执(元)', admin: { description: '相比默认premium模型省下的估算金额(省钱路由的累计价值)' } },
    { name: 'latencyMs', type: 'number', label: '耗时(ms)' },
    { name: 'success', type: 'checkbox', defaultValue: false, label: '是否成功' },
    { name: 'errorCode', type: 'text', label: '错误码' },
    { name: 'formatValid', type: 'checkbox', defaultValue: false, label: '输出格式有效' },
    {
      name: 'countedInMetrics',
      type: 'checkbox',
      defaultValue: true,
      label: '计入 Skill 指标',
      admin: { description: '对比/探测运行(skipAggregate)为 false，不计入 headline 指标，台账对账据此过滤' },
    },
    { name: 'newapiLogId', type: 'text', label: '模型网关 日志 ID' },
  ],
}
