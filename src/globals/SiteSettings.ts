import type { GlobalConfig } from 'payload'
import { isAdmin } from '@/access'

export const SiteSettings: GlobalConfig = {
  slug: 'site-settings',
  label: '站点设置',
  admin: { group: '系统设置' },
  access: {
    read: () => true,
    update: isAdmin,
  },
  fields: [
    { name: 'siteName', type: 'text', defaultValue: '格物', label: '站点名称' },
    {
      name: 'slogan',
      type: 'text',
      defaultValue: 'AI Skill 的可信与兼容控制平面。',
      label: '标语',
    },
    {
      name: 'featuredSkills',
      type: 'relationship',
      relationTo: 'skills',
      hasMany: true,
      label: '首页精选 Skill',
    },
    {
      name: 'essentialStarterPack',
      type: 'array',
      label: '必备 Skill Starter Pack',
      admin: {
        description: '后台配置新用户第一跑 Skill 包：排序、推荐理由和公开默认示例。为空时回退 Skill 自身 isEssential/essentialReason。',
      },
      fields: [
        { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, label: 'Skill' },
        { name: 'order', type: 'number', defaultValue: 0, label: '排序' },
        { name: 'reason', type: 'textarea', label: '为什么先跑' },
        {
          name: 'starterExample',
          type: 'json',
          label: '公开默认示例',
          admin: { description: '给新用户试跑的公开示例对象；不要填写真实客户输入。' },
        },
      ],
    },
    {
      name: 'registrationEmailRequired',
      type: 'checkbox',
      defaultValue: false,
      label: '注册必须填写邮箱',
      admin: {
        description: '开启时注册页要求填写邮箱；关闭时用户可不填，系统会生成内部占位邮箱用于账号登录态。',
      },
    },
    { name: 'announcement', type: 'textarea', label: '公告' },
  ],
}
