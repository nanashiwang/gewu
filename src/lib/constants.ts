// 共享常量：贡献值行为、路由模式、模型价格表（估算用）

export const CONTRIBUTION_ACTIONS = [
  'skill_published', // 发布 Skill 并通过审核
  'skill_favorited', // Skill 被收藏
  'skill_run', // Skill 被成功调用
  'skill_high_rating', // 获得高评分
  'skill_version_update', // 更新版本
  'fix_issue', // 修复严重问题
  'eval_sample', // 提交评测样本被采纳
  'failure_case', // 提交失败案例被确认
  'route_optimization', // 优化模型路由被采用
  'review', // 参与审核且有效
  'security', // 发现安全风险
  'bounty', // 完成悬赏
  'invite', // 邀请高质量用户
  'consume', // 消耗（负值）
  'other',
] as const
export type ContributionAction = (typeof CONTRIBUTION_ACTIONS)[number]

export const ROUTE_MODES = ['cheap', 'quality', 'fast', 'balanced'] as const
export type RouteMode = (typeof ROUTE_MODES)[number]

export const SKILL_CATEGORIES = [
  { name: '内容创作', slug: 'content-creation', icon: '✍️' },
  { name: '办公效率', slug: 'office', icon: '📄' },
  { name: '客服运营', slug: 'customer-service', icon: '💬' },
  { name: 'AI 评测', slug: 'evaluation', icon: '🧪' },
  { name: '教育心理', slug: 'education', icon: '🎓' },
  { name: '代码开发', slug: 'code', icon: '💻' },
] as const

// 模型价格表：每 1K token 估算价（人民币元）。仅用于成本展示，可后续由 模型网关 同步覆盖。
export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  // cn.meta-api.vip 网关可用模型
  'claude-haiku-4-5-20251001': { in: 0.006, out: 0.03 },
  'claude-sonnet-4-6': { in: 0.022, out: 0.11 },
  'claude-opus-4-6': { in: 0.11, out: 0.55 },
  'claude-opus-4-7': { in: 0.11, out: 0.55 },
  'claude-opus-4-8': { in: 0.11, out: 0.55 },
  'gpt-5.4-mini': { in: 0.003, out: 0.012 },
  'gpt-5.4': { in: 0.02, out: 0.08 },
  'gpt-5.5': { in: 0.03, out: 0.12 },
  'grok-4.3': { in: 0.02, out: 0.1 },
  // 通用占位
  'deepseek-chat': { in: 0.001, out: 0.002 },
  'qwen-plus': { in: 0.004, out: 0.012 },
  'qwen2.5:14b': { in: 0, out: 0 },
  'llama3.1:8b': { in: 0, out: 0 },
  default: { in: 0.006, out: 0.03 },
}
