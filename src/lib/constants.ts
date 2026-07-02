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
  'compat_report', // 提交兼容报告（verified Runner）
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

// ── 合规架构切割(总纲 6l)：平台 Key 代付仅限已备案国产模型 ──
// 境外模型(Claude/GPT/Grok 等)仅 BYOK 显式配置可用；平台不代理未备案模型，避免与被整治中转站同一法律定性。
// 可用 APPROVED_PLATFORM_MODELS 环境变量覆盖（逗号分隔）。
const DEFAULT_PLATFORM_MODELS = [
  'deepseek-chat',
  'deepseek-reasoner',
  'qwen-plus',
  'qwen-turbo',
  'qwen-max',
  'glm-4',
  'glm-4-flash',
  'kimi-k2',
  'moonshot-v1-8k',
]
export function approvedPlatformModels(): Set<string> {
  const env = process.env.APPROVED_PLATFORM_MODELS
  if (env) {
    return new Set(
      env
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return new Set(DEFAULT_PLATFORM_MODELS)
}

// credit（算力燃料币）台账交易类型。1 credit = ¥0.01 零售。credit 永不反向变现金。
export const CREDIT_TX_TYPES = [
  'recharge', // CNY 充值（New API 兑换码）→ credit [+]
  'exchange', // 术值兑换 → credit [+]
  'consume', // 跑模型消耗 [-]
  'refund', // 退款 [+]
  'adjust', // 管理员调整 [+/-]
] as const
export type CreditTxType = (typeof CREDIT_TX_TYPES)[number]

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
  // 已备案国产模型（平台代付白名单）—— 估算占位价，上线前接 New API /api/log 覆盖真值
  'deepseek-chat': { in: 0.001, out: 0.002 },
  'deepseek-reasoner': { in: 0.004, out: 0.016 },
  'qwen-plus': { in: 0.004, out: 0.012 },
  'qwen-turbo': { in: 0.0003, out: 0.0006 },
  'qwen-max': { in: 0.02, out: 0.06 },
  'glm-4': { in: 0.05, out: 0.05 },
  'glm-4-flash': { in: 0.0001, out: 0.0001 },
  'kimi-k2': { in: 0.004, out: 0.016 },
  'moonshot-v1-8k': { in: 0.012, out: 0.012 },
  // 本地模型（零成本）
  'qwen2.5:14b': { in: 0, out: 0 },
  'llama3.1:8b': { in: 0, out: 0 },
  default: { in: 0.006, out: 0.03 },
}
