import type { CollectionConfig } from 'payload'
import { isAdmin } from '@/access'
import { maskRechargeCode, normalizeRechargeCode, rechargeCodeDigest, resolveRechargeCreditAmount } from '@/lib/rechargeCodes'
import { rowActionsField } from './fields/rowActions'

// credit 充值码：格物 不碰现金，运营侧/外部 New API 兑换后在后台发放一次性 credit 码。
export const RechargeCodes: CollectionConfig = {
  slug: 'recharge-codes',
  labels: { singular: '充值码', plural: '充值码' },
  admin: {
    useAsTitle: 'codePreview',
    defaultColumns: ['codePreview', 'creditAmount', 'status', 'usedBy', 'usedAt', 'rowActions'],
    group: '成员管理',
  },
  access: {
    read: isAdmin,
    create: isAdmin,
    update: isAdmin,
    delete: () => false,
  },
  hooks: {
    beforeValidate: [
      ({ data, operation }) => {
        data ||= {}
        const raw = normalizeRechargeCode(data?.code)
        if (raw) {
          data.codeHash = rechargeCodeDigest(raw)
          data.codePreview = maskRechargeCode(raw)
          data.code = undefined // 明文只用于本次保存，不落库
        } else if (operation === 'create') {
          throw new Error('创建充值码必须填写明文 code')
        }
        return data
      },
    ],
    beforeChange: [
      ({ data, operation, originalDoc, context }) => {
        if (operation === 'create') {
          if (data?.status && data.status !== 'unused') throw new Error('充值码创建时只能是 unused 状态')
          if (data?.usedBy || data?.usedAt) throw new Error('充值码创建时不能预置使用记录')
          data.creditAmount = resolveRechargeCreditAmount(data?.creditAmount)
          data.status = 'unused'
          return data
        }
        if ((context as any)?.allowRechargeCodeServiceUpdate) return data

        const mutableAdminFields = new Set(['status', 'expiresAt', 'note'])
        for (const key of Object.keys(data || {})) {
          if (!mutableAdminFields.has(key)) {
            throw new Error('充值码金额、哈希、明文和使用记录不可后台修改；如需作废请禁用后重建')
          }
        }

        if (data.status && data.status !== originalDoc?.status) {
          const canDisableUnused = originalDoc?.status === 'unused' && data.status === 'disabled'
          if (!canDisableUnused) throw new Error('充值码状态只能从 unused 改为 disabled，已使用记录不可回滚')
        }
        return data
      },
    ],
  },
  fields: [
    rowActionsField('recharge-codes'),
    {
      name: 'codePreview',
      type: 'text',
      index: true,
      label: '充值码标识',
      admin: { readOnly: true, description: '仅展示前后缀，明文不会落库' },
    },
    {
      name: 'codeHash',
      type: 'text',
      unique: true,
      index: true,
      label: '充值码 HMAC',
      access: { read: () => false, update: () => false },
      admin: { hidden: true, readOnly: true },
    },
    {
      name: 'code',
      type: 'text',
      label: '充值码明文',
      access: { read: () => false, update: () => false },
      admin: { description: '仅创建/重置时填写；保存后立即转 HMAC，不保留明文' },
    },
    { name: 'creditAmount', type: 'number', required: true, min: 1, label: '发放 credit', access: { update: () => false } },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'unused',
      index: true,
      label: '状态',
      options: [
        { label: '未使用', value: 'unused' },
        { label: '已使用', value: 'used' },
        { label: '禁用', value: 'disabled' },
      ],
    },
    { name: 'usedBy', type: 'relationship', relationTo: 'users', label: '使用者', access: { update: () => false }, admin: { readOnly: true } },
    { name: 'usedAt', type: 'date', label: '使用时间', access: { update: () => false }, admin: { readOnly: true } },
    { name: 'expiresAt', type: 'date', label: '过期时间' },
    { name: 'note', type: 'textarea', label: '备注' },
  ],
}
