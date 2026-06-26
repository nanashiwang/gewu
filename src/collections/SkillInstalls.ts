import type { CollectionConfig } from 'payload'
import { isAdmin, ownerOrAdmin } from '@/access'

// 安装记录（≠下载）。一台 Runner 装某 Skill 一条；是「安装/有效安装/活跃安装」指标的来源。
export const SkillInstalls: CollectionConfig = {
  slug: 'skill-installs',
  labels: { singular: '安装记录', plural: '安装记录' },
  admin: {
    useAsTitle: 'id',
    defaultColumns: ['user', 'skill', 'installedVersion', 'status', 'lastUsedAt'],
    group: '成员管理',
  },
  access: {
    read: ownerOrAdmin('user'),
    create: isAdmin, // 仅服务端 overrideAccess（经 Bearer 端点）
    update: isAdmin,
    delete: ownerOrAdmin('user'),
  },
  fields: [
    { name: 'user', type: 'relationship', relationTo: 'users', required: true, label: '用户' },
    { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, label: 'Skill' },
    { name: 'skillVersion', type: 'relationship', relationTo: 'skill-versions', label: '版本' },
    { name: 'runner', type: 'relationship', relationTo: 'runner-clients', label: 'Runner' },
    { name: 'installedVersion', type: 'text', label: '已装版本' },
    { name: 'installedChecksum', type: 'text', label: '已装 checksum' },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'installed',
      label: '状态',
      options: [
        { label: '已安装', value: 'installed' },
        { label: '已移除', value: 'removed' },
      ],
    },
    { name: 'installedAt', type: 'date', label: '安装时间' },
    { name: 'lastUsedAt', type: 'date', label: '最近使用' },
  ],
}
