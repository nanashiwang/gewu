import type { Access, CollectionConfig, FieldAccess, Where } from 'payload'
import { isActiveAccount } from '@/access'
import { relationId } from '@/lib/relaySite'
import { rowActionsField } from './fields/rowActions'

function isRelayStaff(user: unknown): boolean {
  return Boolean(isActiveAccount(user) && ['admin', 'reviewer'].includes(String((user as any).role || '')))
}

const checkRead: Access = ({ req: { user } }) => {
  if (isRelayStaff(user)) return true
  const publicDone: Where = {
    and: [{ status: { equals: 'done' } }, { 'site.status': { equals: 'approved' } }],
  }
  if (isActiveAccount(user)) return { or: [publicDone, { 'site.owner': { equals: user.id } }] }
  return publicDone
}

const ownerOrStaffField: FieldAccess = ({ req: { user }, doc }) => {
  if (!isActiveAccount(user)) return false
  if (isRelayStaff(user)) return true
  const site = (doc as any)?.site
  return relationId(site?.owner) === String(user.id)
}

export const RelayChecks: CollectionConfig = {
  slug: 'relay-checks',
  labels: { singular: '中转检测记录', plural: '中转检测记录' },
  indexes: [
    { fields: ['site', 'createdAt'] },
    { fields: ['site', 'status'] },
    { fields: ['detectorJobId'] },
  ],
  admin: {
    useAsTitle: 'detectorJobId',
    defaultColumns: ['site', 'source', 'protocol', 'model', 'status', 'score', 'createdAt', 'rowActions'],
    group: '中转治理',
    description: '手动和定时检测的不可变历史。写入仅允许服务端检测桥接器。',
  },
  access: {
    read: checkRead,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    rowActionsField('relay-checks'),
    { name: 'site', type: 'relationship', relationTo: 'relay-sites', required: true, index: true, label: '中转站' },
    { name: 'triggeredBy', type: 'relationship', relationTo: 'users', index: true, label: '触发用户' },
    {
      name: 'source',
      type: 'select',
      required: true,
      defaultValue: 'manual',
      index: true,
      label: '来源',
      options: [
        { label: '手动', value: 'manual' },
        { label: '定时', value: 'scheduled' },
      ],
    },
    { name: 'protocol', type: 'select', required: true, options: ['openai', 'anthropic', 'gemini'], label: '协议' },
    { name: 'model', type: 'text', required: true, label: '模型' },
    { name: 'mode', type: 'select', required: true, options: ['quick', 'standard', 'full'], label: '模式' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'queued',
      index: true,
      label: '状态',
      options: [
        { label: '排队中', value: 'queued' },
        { label: '检测中', value: 'running' },
        { label: '已完成', value: 'done' },
        { label: '失败', value: 'error' },
      ],
    },
    { name: 'detectorJobId', type: 'text', unique: true, index: true, label: '检测任务 ID' },
    { name: 'resultUrl', type: 'text', label: '公开报告地址' },
    { name: 'score', type: 'number', index: true, label: '得分' },
    { name: 'grade', type: 'text', label: '等级' },
    { name: 'verdict', type: 'text', index: true, label: '结论' },
    { name: 'summary', type: 'textarea', label: '摘要' },
    { name: 'startedAt', type: 'date', label: '开始时间' },
    { name: 'finishedAt', type: 'date', label: '完成时间' },
    { name: 'durationMs', type: 'number', label: '耗时（毫秒）' },
    { name: 'pollFailures', type: 'number', defaultValue: 0, label: '同步失败次数', access: { read: ownerOrStaffField }, admin: { readOnly: true } },
    { name: 'report', type: 'json', label: '原始报告', access: { read: ownerOrStaffField }, admin: { readOnly: true } },
    { name: 'error', type: 'textarea', label: '错误', access: { read: ownerOrStaffField }, admin: { readOnly: true } },
  ],
}
