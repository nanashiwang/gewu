import type { Access, CollectionConfig, FieldAccess, Where } from 'payload'
import { APIError } from 'payload'
import { isActiveAccount } from '@/access'
import { encryptSecret } from '@/lib/secrets'
import {
  createRelayClaimToken,
  createRelaySlug,
  normalizeRelaySiteInput,
  normalizePublicHttpUrl,
  normalizeRelayApiUrl,
  relationId,
  relayClaimDomain,
  relayInputErrorMessage,
} from '@/lib/relaySite'
import { rowActionsField } from './fields/rowActions'

function isRelayStaff(user: unknown): boolean {
  return Boolean(isActiveAccount(user) && ['admin', 'reviewer'].includes(String((user as any).role || '')))
}

const relayRead: Access = ({ req: { user } }) => {
  if (isRelayStaff(user)) return true
  const approved: Where = { status: { equals: 'approved' } }
  if (isActiveAccount(user)) return { or: [approved, { owner: { equals: user.id } }] }
  return approved
}

const relayWrite: Access = ({ req: { user } }) => {
  if (!isActiveAccount(user)) return false
  if (isRelayStaff(user)) return true
  return { owner: { equals: user.id } }
}

const relayCreate: Access = ({ req: { user } }) => isActiveAccount(user)
const staffField: FieldAccess = ({ req: { user } }) => isRelayStaff(user)
const neverField: FieldAccess = () => false

const ownerOrStaffField: FieldAccess = ({ req: { user }, doc }) => {
  if (!isActiveAccount(user)) return false
  if (isRelayStaff(user)) return true
  return relationId((doc as any)?.owner) === String(user.id)
}

const MATERIAL_FIELDS = new Set(['name', 'websiteUrl', 'apiBaseUrl', 'description', 'contacts'])

export const RelaySites: CollectionConfig = {
  slug: 'relay-sites',
  labels: { singular: '中转站', plural: '中转站' },
  indexes: [
    { fields: ['owner', 'status'] },
    { fields: ['status', 'claimStatus'] },
    { fields: ['scheduleEnabled', 'nextCheckAt'] },
  ],
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'owner', 'protocol', 'status', 'claimStatus', 'lastScore', 'rowActions'],
    group: '中转治理',
    description: '用户提交的中转站、所有权验证、审核状态和定时检测配置。API Key 只保存密文且永不回显。',
  },
  access: {
    read: relayRead,
    create: relayCreate,
    update: relayWrite,
    delete: relayWrite,
  },
  fields: [
    rowActionsField('relay-sites'),
    { name: 'name', type: 'text', required: true, index: true, label: '中转站名称' },
    { name: 'slug', type: 'text', required: true, unique: true, index: true, label: '公开标识', admin: { readOnly: true } },
    {
      name: 'owner',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      label: '所有者',
      access: { create: staffField, update: staffField },
    },
    { name: 'websiteUrl', type: 'text', required: true, label: '官网地址' },
    { name: 'apiBaseUrl', type: 'text', required: true, label: 'API 地址' },
    { name: 'description', type: 'textarea', label: '简介' },
    {
      name: 'contacts',
      type: 'json',
      label: '联系方式',
      access: { read: ownerOrStaffField },
      admin: { description: '由用户前台维护；每项包含 type、value、isPublic。公开展示仅输出 isPublic=true 的项。' },
    },
    {
      name: 'protocol',
      type: 'select',
      required: true,
      defaultValue: 'openai',
      index: true,
      label: '主检测协议',
      options: [
        { label: 'OpenAI', value: 'openai' },
        { label: 'Claude / Anthropic', value: 'anthropic' },
        { label: 'Gemini', value: 'gemini' },
      ],
    },
    { name: 'model', type: 'text', required: true, label: '主检测模型' },
    {
      name: 'mode',
      type: 'select',
      required: true,
      defaultValue: 'standard',
      label: '检测模式',
      options: [
        { label: '快速', value: 'quick' },
        { label: '标准', value: 'standard' },
        { label: '完整', value: 'full' },
      ],
    },
    {
      name: 'apiKeyEncrypted',
      type: 'text',
      label: 'API Key 密文',
      access: { read: neverField, create: neverField, update: neverField },
      admin: { hidden: true, readOnly: true },
    },
    {
      name: 'hasApiKey',
      type: 'checkbox',
      defaultValue: false,
      label: '已配置 API Key',
      access: { create: neverField, update: neverField },
      admin: { readOnly: true },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      required: true,
      index: true,
      label: '审核状态',
      access: { create: staffField, update: staffField },
      options: [
        { label: '草稿', value: 'draft' },
        { label: '待审核', value: 'pending' },
        { label: '已通过', value: 'approved' },
        { label: '已拒绝', value: 'rejected' },
        { label: '已暂停', value: 'suspended' },
      ],
    },
    {
      name: 'claimStatus',
      type: 'select',
      defaultValue: 'unverified',
      required: true,
      index: true,
      label: '认领状态',
      access: { create: staffField, update: staffField },
      options: [
        { label: '未验证', value: 'unverified' },
        { label: '待验证', value: 'pending' },
        { label: '已验证', value: 'verified' },
        { label: '验证失败', value: 'failed' },
        { label: '人工验证', value: 'manual' },
      ],
    },
    {
      name: 'claimDomain',
      type: 'text',
      required: true,
      index: true,
      label: '认领域名',
      access: { create: neverField, update: staffField },
      admin: { readOnly: true },
    },
    {
      name: 'claimToken',
      type: 'text',
      required: true,
      label: 'DNS 验证令牌',
      access: { read: ownerOrStaffField, create: neverField, update: staffField },
      admin: { readOnly: true },
    },
    { name: 'claimedAt', type: 'date', label: '认领时间', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    { name: 'claimCheckedAt', type: 'date', label: '最近验证时间', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    {
      name: 'scheduleEnabled',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      label: '启用定时检测',
    },
    {
      name: 'scheduleIntervalHours',
      type: 'select',
      required: true,
      defaultValue: '24',
      label: '检测间隔',
      options: [
        { label: '每 6 小时', value: '6' },
        { label: '每 12 小时', value: '12' },
        { label: '每天', value: '24' },
        { label: '每 3 天', value: '72' },
        { label: '每周', value: '168' },
      ],
    },
    { name: 'nextCheckAt', type: 'date', index: true, label: '下次检测', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    { name: 'lastCheckAt', type: 'date', label: '最近检测', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    { name: 'lastScore', type: 'number', label: '最近得分', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    { name: 'lastGrade', type: 'text', label: '最近等级', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    { name: 'lastVerdict', type: 'text', label: '最近结论', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    { name: 'reviewNotes', type: 'textarea', label: '审核备注', access: { create: staffField, update: staffField, read: ownerOrStaffField } },
    { name: 'reviewedBy', type: 'relationship', relationTo: 'users', label: '审核人', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
    { name: 'reviewedAt', type: 'date', label: '审核时间', access: { create: neverField, update: staffField }, admin: { readOnly: true } },
  ],
  hooks: {
    beforeValidate: [
      ({ data, originalDoc, operation, req }) => {
        if (!data) return data
        const actor = req.user as any
        const staff = isRelayStaff(actor)

        if (operation === 'create') {
          if (!data.owner && actor?.id) data.owner = actor.id
          if (!data.owner) throw new APIError('中转站必须绑定所有者', 400)
          if (data.apiBaseUrl && !data.slug) data.slug = createRelaySlug(String(data.name || 'relay'), String(data.apiBaseUrl))
          if (!data.claimToken) data.claimToken = createRelayClaimToken()
        }

        try {
          if (Object.prototype.hasOwnProperty.call(data, 'websiteUrl')) data.websiteUrl = normalizePublicHttpUrl(data.websiteUrl, '官网地址')
          if (Object.prototype.hasOwnProperty.call(data, 'apiBaseUrl')) {
            data.apiBaseUrl = normalizeRelayApiUrl(data.apiBaseUrl)
            data.claimDomain = relayClaimDomain(String(data.apiBaseUrl))
          }

          const publicInputKeys = ['name', 'description', 'protocol', 'model', 'mode', 'contacts', 'scheduleEnabled', 'scheduleIntervalHours']
          const publicInput = Object.fromEntries(publicInputKeys.filter((key) => Object.prototype.hasOwnProperty.call(data, key)).map((key) => [key, data[key]]))
          if (Object.keys(publicInput).length > 0) {
            const normalized = normalizeRelaySiteInput(publicInput, { partial: true }) as Record<string, unknown>
            if (Object.prototype.hasOwnProperty.call(normalized, 'scheduleIntervalHours')) {
              normalized.scheduleIntervalHours = String(normalized.scheduleIntervalHours)
            }
            Object.assign(data, normalized)
          }
        } catch (error) {
          throw new APIError(relayInputErrorMessage(error), 400)
        }

        if (Object.prototype.hasOwnProperty.call(data, 'apiKeyEncrypted')) {
          const raw = String(data.apiKeyEncrypted || '').trim()
          data.apiKeyEncrypted = raw ? encryptSecret(raw) : null
          data.hasApiKey = Boolean(raw)
        }

        if (operation === 'update' && originalDoc && actor && !staff) {
          if (relationId(originalDoc.owner) !== String(actor.id)) throw new APIError('只能修改自己的中转站', 403)
          const apiChanged = data.apiBaseUrl && relayClaimDomain(String(data.apiBaseUrl)) !== relayClaimDomain(String(originalDoc.apiBaseUrl))
          if (apiChanged) {
            data.claimStatus = 'unverified'
            data.claimToken = createRelayClaimToken()
            data.claimedAt = null
            data.status = 'draft'
          } else if (originalDoc.status === 'approved' && Object.keys(data).some((key) => {
            if (!MATERIAL_FIELDS.has(key)) return false
            if (key === 'contacts') return JSON.stringify(data.contacts || []) !== JSON.stringify(originalDoc.contacts || [])
            return String(data[key] ?? '') !== String(originalDoc[key] ?? '')
          })) {
            data.status = 'pending'
          }
        }

        const merged = { ...(originalDoc || {}), ...data }
        if (!Array.isArray(merged.contacts) || merged.contacts.length === 0) {
          throw new APIError('至少填写 1 个有效联系方式，便于格物运营联系站长', 400)
        }
        if (merged.scheduleEnabled && !merged.apiKeyEncrypted) throw new APIError('启用定时检测前必须配置 API Key', 400)
        if (data.status === 'approved' && !['verified', 'manual'].includes(String(merged.claimStatus || ''))) {
          throw new APIError('站点尚未完成所有权验证，不能通过审核', 409)
        }
        if (staff && originalDoc && data.status && data.status !== originalDoc.status) {
          data.reviewedBy = actor?.id || data.reviewedBy
          data.reviewedAt = new Date().toISOString()
        }
        return data
      },
    ],
    beforeDelete: [
      async ({ req, id }) => {
        const user = req.user as any
        if (isRelayStaff(user)) return
        const doc = await req.payload.findByID({ collection: 'relay-sites' as any, id, depth: 0, overrideAccess: true, req }).catch(() => null) as any
        if (doc && !['draft', 'rejected'].includes(String(doc.status || ''))) {
          throw new APIError('待审核或已公开的中转站不能直接删除，请先联系管理员', 409)
        }
      },
    ],
  },
}
