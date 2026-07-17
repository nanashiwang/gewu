import type { CollectionConfig } from 'payload'
import { APIError } from 'payload'
import { isCreatorOrAbove, ownSkillVersionOrStaff, readableSkillVersion, isAdmin, sensitiveSkillVersionField } from '@/access'
import { skillContractHash, contractStatusFor } from '@/lib/skillContract'
import { rowActionsField } from './fields/rowActions'

export const SkillVersions: CollectionConfig = {
  slug: 'skill-versions',
  labels: { singular: 'Skill 版本', plural: 'Skill 版本' },
  admin: {
    useAsTitle: 'version',
    defaultColumns: ['skill', 'version', 'status', 'createdBy', 'createdAt', 'rowActions'],
    group: 'Skill 内容',
  },
  access: {
    read: readableSkillVersion,
    create: isCreatorOrAbove,
    update: ownSkillVersionOrStaff, // 修复越权：仅所属 Skill 作者/审核/管理可改
    delete: isAdmin,
  },
  fields: [
    rowActionsField('skill-versions'),
    { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, label: '所属 Skill' },
    { name: 'version', type: 'text', required: true, defaultValue: '1.0.0', label: '版本号' },
    {
      name: 'systemPrompt',
      type: 'textarea',
      label: 'System Prompt（角色/约束）',
      access: { read: sensitiveSkillVersionField },
      admin: { description: 'Spec v1 的 prompt.system；可空' },
    },
    {
      name: 'promptTemplate',
      type: 'textarea',
      required: true,
      label: 'User 模板（user_template）',
      access: { read: sensitiveSkillVersionField },
      admin: { description: 'Spec v1 的 prompt.user_template；支持 {{变量名}} 占位符' },
    },
    {
      name: 'inputSchema',
      type: 'json',
      label: '输入字段定义',
      admin: { description: '形如 {"topic":{"type":"string","label":"主题","required":true}}' },
    },
    { name: 'outputSchema', type: 'json', label: '输出格式定义' },
    {
      name: 'recommendedModels',
      type: 'json',
      label: '推荐模型',
      admin: { description: '形如 {"cloud":["deepseek-chat"],"local":["qwen2.5:14b"]}' },
    },
    {
      name: 'routePolicy',
      type: 'json',
      label: '路由策略',
      access: { read: sensitiveSkillVersionField },
      admin: { description: '形如 {"default":"balanced","strategies":{"cheap":[...],"quality":[...],"fallback":[...]}}' },
    },
    { name: 'changelog', type: 'textarea', label: '更新说明', access: { read: sensitiveSkillVersionField } },
    { name: 'contractHash', type: 'text', index: true, label: 'Contract Hash', admin: { readOnly: true } },
    {
      name: 'contractStatus',
      type: 'select',
      defaultValue: 'initial',
      label: 'Contract 状态',
      admin: { readOnly: true },
      options: [
        { label: '初始', value: 'initial' },
        { label: '兼容变更', value: 'compatible_change' },
        { label: '破坏性变更', value: 'breaking_change' },
      ],
    },
    // ── 格物 Skill Spec v1 运行时声明 ──
    {
      name: 'license',
      type: 'text',
      defaultValue: 'CC-BY-NC-4.0',
      label: '许可证',
      admin: { position: 'sidebar' },
    },
    {
      name: 'minRunnerVersion',
      type: 'text',
      defaultValue: '0.2.0',
      label: '最低 Runner 版本',
      admin: { position: 'sidebar' },
    },
    {
      name: 'permissions',
      type: 'group',
      label: '权限声明（Prompt Skill 应全为否）',
      fields: [
        { name: 'network', type: 'checkbox', defaultValue: false, label: '网络' },
        { name: 'fileRead', type: 'checkbox', defaultValue: false, label: '读文件' },
        { name: 'fileWrite', type: 'checkbox', defaultValue: false, label: '写文件' },
        { name: 'shell', type: 'checkbox', defaultValue: false, label: 'Shell' },
      ],
    },
    {
      name: 'examples',
      type: 'json',
      label: '示例（输入/输出）',
      access: { read: sensitiveSkillVersionField },
      admin: { description: '形如 [{"input":{...},"output":{...}}]' },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      label: '状态',
      options: [
        { label: '草稿', value: 'draft' },
        { label: '生效', value: 'active' },
        { label: '废弃', value: 'deprecated' },
      ],
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      label: '创建人',
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
  hooks: {
    beforeValidate: [
      async ({ data, req, originalDoc }) => {
        // 归属校验（纵深防御，覆盖 create 指向他人 Skill 的越权——create access 无法看 data.skill）：
        // 非登录/无 user 的服务端可信写入(seed/发布端点 overrideAccess 且 author 恒为本人)放行；staff 放行。
        const user = req.user
        if (!user) return data
        if (user.role === 'admin' || user.role === 'reviewer') return data
        const skillRef = (data?.skill ?? originalDoc?.skill) as any
        const skillId = typeof skillRef === 'object' ? skillRef?.id : skillRef
        if (!skillId) return data // 交给 required 校验报错
        const skill = await req.payload
          .findByID({ collection: 'skills', id: skillId, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        const authorId = skill && (typeof skill.author === 'object' ? (skill.author as any)?.id : skill.author)
        if (!authorId || String(authorId) !== String(user.id)) {
          throw new APIError('无权为他人的 Skill 创建或修改版本', 403)
        }
        return data
      },
    ],
    beforeDelete: [
      async ({ id, req }) => {
        // skill-artifacts.skillVersion 为必填(NOT NULL) 外键，删版本前先级联删除其制品快照
        await req.payload.delete({
          collection: 'skill-artifacts',
          where: { skillVersion: { equals: id } },
          req,
          overrideAccess: true,
        })
      },
    ],
    beforeChange: [
      ({ data, req, operation, originalDoc }) => {
        const merged = { ...(originalDoc || {}), ...(data || {}) }
        data.contractHash = skillContractHash(merged)
        data.contractStatus = operation === 'create' ? 'initial' : contractStatusFor(originalDoc, merged)
        if (operation === 'create' && req.user && !data.createdBy) {
          data.createdBy = req.user.id
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation !== 'create') return doc
        const skillId = typeof doc.skill === 'object' ? doc.skill?.id : doc.skill
        if (!skillId) return doc
        try {
          const skill = await req.payload.findByID({
            collection: 'skills',
            id: skillId,
            overrideAccess: true,
            depth: 0,
            req,
          })
          const patch: Record<string, unknown> = {
            lastUpdatedAt: new Date().toISOString(),
          }
          if (!skill.currentVersion) patch.currentVersion = doc.id
          await req.payload.update({
            collection: 'skills',
            id: skillId,
            data: patch,
            overrideAccess: true,
            req,
          })
        } catch (e) {
          req.payload.logger?.error(`SkillVersions afterChange 失败: ${(e as Error).message}`)
        }
        return doc
      },
    ],
  },
}
