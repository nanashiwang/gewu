import type { CollectionConfig } from 'payload'
import { APIError } from 'payload'
import { isAdmin, isCreatorOrAbove, ownSkillVersionOrStaff } from '@/access'
import { buildAdapterEvidenceHash } from '@/lib/adapterProfile'
import { writeEvidenceSnapshot } from '@/lib/evidenceSnapshot'
import { rowActionsField } from './fields/rowActions'

function relationId(value: unknown): string | undefined {
  if (!value) return undefined
  return typeof value === 'object' ? String((value as any).id || '') || undefined : String(value)
}

// Adapter Profile：Skill × Model 的适配补丁，让平台不只评价兼容性，也能修复兼容性。
export const AdapterProfiles: CollectionConfig = {
  slug: 'adapter-profiles',
  labels: { singular: '适配补丁', plural: '适配补丁' },
  indexes: [
    { fields: ['skill', 'modelName', 'status'] },
    { fields: ['skill', 'modelProfile', 'status'] },
  ],
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'skill', 'modelName', 'status', 'liftScore', 'rowActions'],
    group: '可信与兼容',
    description: 'Skill × Model 的 prompt/schema/decoding/retry 适配补丁。',
  },
  access: {
    read: ownSkillVersionOrStaff,
    create: isCreatorOrAbove,
    update: isCreatorOrAbove,
    delete: isAdmin,
  },
  fields: [
    rowActionsField('adapter-profiles'),
    { name: 'title', type: 'text', required: true, label: '标题' },
    { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, index: true, label: 'Skill' },
    { name: 'skillVersion', type: 'relationship', relationTo: 'skill-versions', label: '适用版本' },
    { name: 'sourceFailureCase', type: 'relationship', relationTo: 'failure-cases', label: '来源失败案例' },
    { name: 'modelProfile', type: 'relationship', relationTo: 'model-profiles', label: '模型画像' },
    { name: 'modelName', type: 'text', required: true, index: true, label: '模型名' },
    { name: 'modelVersion', type: 'text', index: true, label: '模型版本' },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      index: true,
      label: '状态',
      options: [
        { label: '草稿', value: 'draft' },
        { label: '启用', value: 'active' },
        { label: '观察中', value: 'observed' },
        { label: '停用', value: 'disabled' },
      ],
    },
    {
      name: 'reviewStatus',
      type: 'select',
      defaultValue: 'pending',
      index: true,
      label: '人工评审状态',
      options: [
        { label: '待评审', value: 'pending' },
        { label: '需修改', value: 'needs_changes' },
        { label: '已批准', value: 'approved' },
        { label: '已拒绝', value: 'rejected' },
      ],
    },
    { name: 'reviewedBy', type: 'relationship', relationTo: 'users', label: '评审人', admin: { readOnly: true } },
    { name: 'reviewedAt', type: 'date', label: '评审时间', admin: { readOnly: true } },
    { name: 'reviewerNotes', type: 'textarea', label: '评审备注' },
    { name: 'systemPromptAppend', type: 'textarea', label: 'System 追加补丁' },
    { name: 'userPromptAppend', type: 'textarea', label: 'User 追加补丁' },
    { name: 'outputSchemaPatch', type: 'json', label: '输出 schema 补丁' },
    { name: 'decodingPatch', type: 'json', label: '解码参数补丁' },
    { name: 'retryPolicy', type: 'json', label: '重试/修复策略' },
    { name: 'failureTypes', type: 'json', label: '针对失败类型' },
    { name: 'liftScore', type: 'number', defaultValue: 0, label: '适配提升分' },
    { name: 'beforeMetrics', type: 'json', label: '适配前指标' },
    { name: 'afterMetrics', type: 'json', label: '适配后指标' },
    { name: 'evidenceHash', type: 'text', index: true, label: '证据 Hash' },
    { name: 'lastVerifiedAt', type: 'date', label: '最近验证时间' },
  ],
  hooks: {
    beforeValidate: [
      async ({ data, originalDoc, req }) => {
        const merged = { ...(originalDoc || {}), ...(data || {}) }
        const skillId = relationId(merged.skill)
        if (!skillId) return data

        const skill = await req.payload
          .findByID({ collection: 'skills', id: skillId, overrideAccess: true, depth: 0, req })
          .catch(() => null) as any
        if (!skill) throw new APIError('Adapter 关联的 Skill 不存在', 400)

        const user = req.user as any
        const isStaff = user && ['admin', 'reviewer'].includes(String(user.role || ''))
        if (user && !['admin', 'reviewer'].includes(String(user.role || ''))) {
          const authorId = relationId(skill.author)
          if (!authorId || String(authorId) !== String(user.id)) {
            throw new APIError('无权为他人的 Skill 创建或修改 Adapter', 403)
          }
          if (data?.reviewStatus && String(data.reviewStatus) !== String(originalDoc?.reviewStatus || 'pending')) {
            throw new APIError('只有审核员可以修改 Adapter 人工评审状态', 403)
          }
        }

        const skillVersionId = relationId(merged.skillVersion)
        if (skillVersionId) {
          const version = await req.payload
            .findByID({ collection: 'skill-versions', id: skillVersionId, overrideAccess: true, depth: 0, req })
            .catch(() => null) as any
          if (!version || relationId(version.skill) !== skillId) {
            throw new APIError('Adapter 关联的 SkillVersion 不属于该 Skill', 400)
          }
        }

        const failureCaseId = relationId(merged.sourceFailureCase)
        if (failureCaseId) {
          const failureCase = await req.payload
            .findByID({ collection: 'failure-cases', id: failureCaseId, overrideAccess: true, depth: 0, req })
            .catch(() => null) as any
          if (!failureCase || relationId(failureCase.skill) !== skillId) {
            throw new APIError('Adapter 关联的 FailureCase 不属于该 Skill', 400)
          }
        }

        if (isStaff && data?.status === 'active' && !data.reviewStatus && merged.reviewStatus !== 'approved') {
          data.reviewStatus = 'approved'
        }
        if (merged.status === 'active' && (data?.reviewStatus || merged.reviewStatus || 'pending') !== 'approved') {
          throw new APIError('Adapter 启用前必须由审核员批准', 403)
        }

        return data
      },
    ],
    beforeChange: [
      ({ data, originalDoc, req }) => {
        const merged = { ...(originalDoc || {}), ...(data || {}) }
        data.evidenceHash = buildAdapterEvidenceHash(merged)
        if (!data.lastVerifiedAt && data.status === 'active') data.lastVerifiedAt = new Date().toISOString()
        if (data.reviewStatus && data.reviewStatus !== originalDoc?.reviewStatus && ['approved', 'rejected', 'needs_changes'].includes(String(data.reviewStatus))) {
          data.reviewedAt = new Date().toISOString()
          if (req?.user && ['admin', 'reviewer'].includes(String((req.user as any).role || ''))) data.reviewedBy = (req.user as any).id
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, req }) => {
        try {
          await writeEvidenceSnapshot(req.payload, {
            targetType: 'adapter_profile',
            targetId: String(doc.id),
            evidenceHash: doc.evidenceHash,
            targetSummary: {
              skill: relationId(doc.skill),
              skillVersion: relationId(doc.skillVersion),
              sourceFailureCase: relationId(doc.sourceFailureCase),
              modelName: doc.modelName,
              modelVersion: doc.modelVersion || doc.modelProfile?.modelVersion || null,
              failureTypes: doc.failureTypes,
              liftScore: doc.liftScore,
            },
          })
        } catch (e) {
          req.payload.logger?.error(`writeEvidenceSnapshot(adapter_profile) 失败: ${(e as Error).message}`)
        }
        return doc
      },
    ],
  },
}
