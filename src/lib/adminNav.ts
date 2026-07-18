// 控制台「管理」区导航数据：与 Payload 后台分组保持一致（src/payload.config.ts）
// 供客户端侧栏 ConsoleSidebar 与服务端 /console/admin/[slug] 页共用（纯数据，无服务端依赖）

export const STAFF_ROLES = ['admin', 'reviewer', 'enterprise_admin']

export interface AdminItem {
  slug: string
  label: string
  kind: 'collection' | 'global'
}
export interface AdminGroup {
  key: string
  label: string
  items: AdminItem[]
}

// 顺序与归属对齐 payload.config.ts 的分组（已剔除 hidden 的 device-codes）
export const ADMIN_GROUPS: AdminGroup[] = [
  {
    key: 'relay',
    label: '中转治理',
    items: [
      { slug: 'relay-sites', label: '中转站', kind: 'collection' },
      { slug: 'relay-checks', label: '检测记录', kind: 'collection' },
    ],
  },
  {
    key: 'skill',
    label: 'Skill 内容',
    items: [
      { slug: 'skills', label: 'Skill', kind: 'collection' },
      { slug: 'skill-versions', label: 'Skill 版本', kind: 'collection' },
      { slug: 'skill-artifacts', label: 'Skill 制品', kind: 'collection' },
      { slug: 'categories', label: '分类', kind: 'collection' },
      { slug: 'skill-runs', label: '运行记录', kind: 'collection' },
      { slug: 'bounties', label: '悬赏', kind: 'collection' },
      { slug: 'compat-reports', label: '兼容报告', kind: 'collection' },
    ],
  },
  {
    key: 'members',
    label: '成员管理',
    items: [
      { slug: 'users', label: '用户', kind: 'collection' },
      { slug: 'invite-codes', label: '邀请码', kind: 'collection' },
      { slug: 'contribution-logs', label: '贡献值流水', kind: 'collection' },
      { slug: 'contribution-rules', label: '贡献值规则', kind: 'collection' },
      { slug: 'favorites', label: '收藏', kind: 'collection' },
      { slug: 'runner-clients', label: 'Runner 实例', kind: 'collection' },
      { slug: 'skill-installs', label: '安装记录', kind: 'collection' },
    ],
  },
  {
    key: 'moderation',
    label: '审核治理',
    items: [
      { slug: 'reviews', label: '评论', kind: 'collection' },
      { slug: 'reports', label: '举报', kind: 'collection' },
    ],
  },
  {
    key: 'enterprise',
    label: '企业治理',
    items: [
      { slug: 'organizations', label: '组织', kind: 'collection' },
      { slug: 'organization-members', label: '组织成员', kind: 'collection' },
      { slug: 'enterprise-registries', label: '企业注册表', kind: 'collection' },
      { slug: 'skill-passports', label: 'Skill Passport', kind: 'collection' },
      { slug: 'model-profiles', label: '模型画像', kind: 'collection' },
      { slug: 'adapter-profiles', label: '适配补丁', kind: 'collection' },
      { slug: 'failure-cases', label: '失败案例', kind: 'collection' },
      { slug: 'compat-test-cases', label: '兼容测试样例', kind: 'collection' },
    ],
  },
  {
    key: 'system',
    label: '系统设置',
    items: [
      { slug: 'media', label: '媒体', kind: 'collection' },
      { slug: 'site-settings', label: '站点设置', kind: 'global' },
      { slug: 'deployment-settings', label: '部署设置', kind: 'global' },
    ],
  },
]

export const ADMIN_ITEMS: Record<string, AdminItem> = Object.fromEntries(
  ADMIN_GROUPS.flatMap((g) => g.items.map((i) => [i.slug, i])),
)

// 后台真实嵌入地址
export function adminEmbedUrl(item: AdminItem): string {
  return item.kind === 'global'
    ? `/admin/globals/${item.slug}`
    : `/admin/collections/${item.slug}`
}
