import type { CollectionConfig } from 'payload'
import { isAdmin } from '@/access'

// 发布时冻结的不可变 manifest 快照。由系统生成，下载时直接发存量字节。
export const SkillArtifacts: CollectionConfig = {
  slug: 'skill-artifacts',
  labels: { singular: 'Skill 制品', plural: 'Skill 制品' },
  admin: {
    useAsTitle: 'checksum',
    defaultColumns: ['skill', 'version', 'format', 'checksum', 'downloadCount'],
    group: 'Skill 内容',
    description: '发布时冻结的不可变 manifest 快照（系统生成，请勿手改）',
  },
  access: {
    read: () => true, // 与下载内容同级公开
    create: isAdmin, // 仅服务端 overrideAccess 生成
    update: isAdmin,
    delete: isAdmin,
  },
  fields: [
    { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, label: 'Skill' },
    {
      name: 'skillVersion',
      type: 'relationship',
      relationTo: 'skill-versions',
      required: true,
      index: true,
      label: '版本',
    },
    { name: 'version', type: 'text', label: '版本号' },
    {
      name: 'format',
      type: 'select',
      required: true,
      index: true,
      label: '格式',
      options: [
        { label: 'YAML', value: 'yaml' },
        { label: 'JSON', value: 'json' },
      ],
    },
    {
      name: 'manifest',
      type: 'textarea',
      label: 'Manifest 内容（冻结）',
      admin: { readOnly: true },
    },
    { name: 'checksum', type: 'text', index: true, label: 'Checksum', admin: { readOnly: true } },
    { name: 'fileSize', type: 'number', label: '字节数', admin: { readOnly: true } },
    { name: 'downloadCount', type: 'number', defaultValue: 0, label: '下载次数' },
  ],
}
