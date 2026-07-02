import type { CollectionConfig } from 'payload'
import { isAdmin } from '@/access'
import { rowActionsField } from './fields/rowActions'

// 本地模型兼容报告（原始）。只含可聚合指标，绝不含输入/输出原文。
// 信任模型：raw 报告永不直接上榜，聚合后展示；社区报告仅展示不计术值（verified 通道留后续）。
export const CompatReports: CollectionConfig = {
  slug: 'compat-reports',
  labels: { singular: '兼容报告', plural: '兼容报告' },
  admin: {
    useAsTitle: 'id',
    defaultColumns: ['skill', 'modelName', 'success', 'formatValid', 'latencyMs', 'source', 'rowActions'],
    group: 'Skill 内容',
    description: '本地模型兼容报告（系统接收，不含输入/输出原文）',
  },
  access: {
    read: () => true, // 无 PII、无输入输出，可公开聚合
    create: isAdmin, // 仅服务端 overrideAccess（经 Bearer 端点）
    update: isAdmin,
    delete: isAdmin,
  },
  fields: [
    rowActionsField('compat-reports'),
    { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, index: true, label: 'Skill' },
    { name: 'skillVersion', type: 'relationship', relationTo: 'skill-versions', label: '版本' },
    { name: 'runner', type: 'relationship', relationTo: 'runner-clients', label: 'Runner（具名）' },
    { name: 'anonymousUserHash', type: 'text', index: true, label: '匿名哈希' },
    { name: 'modelProvider', type: 'text', label: '模型来源' },
    { name: 'modelName', type: 'text', index: true, label: '模型' },
    { name: 'modelVersion', type: 'text', label: '模型版本' },
    { name: 'success', type: 'checkbox', defaultValue: false, label: '成功' },
    { name: 'latencyMs', type: 'number', label: '耗时(ms)' },
    { name: 'formatValid', type: 'checkbox', defaultValue: false, label: '格式有效' },
    { name: 'errorType', type: 'text', index: true, label: '错误类型' },
    { name: 'inputSizeBucket', type: 'text', label: '输入规模档' },
    { name: 'outputSizeBucket', type: 'text', label: '输出规模档' },
    { name: 'runnerVersion', type: 'text', label: 'Runner 版本' },
    {
      name: 'source',
      type: 'select',
      defaultValue: 'community',
      label: '来源',
      options: [
        { label: '社区', value: 'community' },
        { label: '已验证', value: 'verified' },
        { label: '在线试用', value: 'online' },
      ],
    },
  ],
}
