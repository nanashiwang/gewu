// 第一批官方 Skill 种子数据（产品文档 §18）

export interface SeedSkill {
  slug: string
  title: string
  description: string
  category: string // 对应 SKILL_CATEGORIES 的 slug
  featured?: boolean
  promptTemplate: string
  inputSchema: Record<string, any>
  outputSchema: Record<string, any>
  recommendedModels: { cloud: string[]; local: string[] }
  routePolicy: { default: string; strategies: Record<string, string[]> }
}

// 当前 模型网关 网关（cn.meta-api.vip）可用模型
const M = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  gptMini: 'gpt-5.4-mini',
  gpt: 'gpt-5.5',
}

const CLOUD = { cloud: [M.haiku, M.sonnet, M.gptMini], local: ['qwen2.5:14b', 'llama3.1:8b'] }

function route(def: string) {
  return {
    default: def,
    strategies: {
      cheap: [M.haiku, M.gptMini],
      quality: [M.opus, M.sonnet],
      fast: [M.gptMini, M.haiku],
      balanced: [M.haiku, M.sonnet],
      fallback: [M.haiku, M.gptMini, M.sonnet],
    },
  }
}

export const SEED_SKILLS: SeedSkill[] = [
  {
    slug: 'xhs-title-generator',
    title: '小红书标题生成器',
    description: '根据主题、人群与风格，一键生成 10 个高点击小红书标题。',
    category: 'content-creation',
    featured: true,
    promptTemplate: [
      '你是一名资深小红书内容编辑。',
      '请根据以下信息生成 10 个小红书标题：',
      '主题：{{topic}}',
      '目标人群：{{audience}}',
      '风格：{{style}}',
      '',
      '要求：标题口语化、有点击欲、可含 emoji；避免夸大与违规表述。',
      '请只返回 JSON，形如 {"titles": ["...", "..."], "reason": "选题说明"}。',
    ].join('\n'),
    inputSchema: {
      topic: { type: 'string', label: '主题', required: true, placeholder: '如：秋季护肤' },
      audience: { type: 'string', label: '目标人群', required: false, placeholder: '如：25-30 岁职场女性' },
      style: {
        type: 'select',
        label: '风格',
        required: false,
        options: ['温暖', '犀利', '专业', '情绪共鸣'],
      },
    },
    outputSchema: {
      titles: { type: 'array', item_type: 'string' },
      reason: { type: 'string' },
    },
    recommendedModels: CLOUD,
    routePolicy: route('balanced'),
  },
  {
    slug: 'meeting-minutes',
    title: '会议纪要整理',
    description: '把零散的会议记录整理为结构化纪要：议题、结论、待办与负责人。',
    category: 'office',
    featured: true,
    promptTemplate: [
      '你是一名专业的会议秘书。请把下面的会议记录整理为规范纪要。',
      '会议主题：{{topic}}',
      '原始记录：',
      '{{notes}}',
      '',
      '请只返回 JSON，形如 {"summary":"一句话总结","decisions":["..."],"todos":[{"task":"...","owner":"...","due":"..."}]}。',
    ].join('\n'),
    inputSchema: {
      topic: { type: 'string', label: '会议主题', required: false },
      notes: { type: 'text', label: '原始记录', required: true, placeholder: '粘贴会议中的零散记录…' },
    },
    outputSchema: {
      summary: { type: 'string' },
      decisions: { type: 'array', item_type: 'string' },
      todos: { type: 'array' },
    },
    recommendedModels: CLOUD,
    routePolicy: route('quality'),
  },
  {
    slug: 'email-polish',
    title: '邮件润色',
    description: '把口语化或粗糙的邮件草稿润色为得体、专业的中文商务邮件。',
    category: 'office',
    promptTemplate: [
      '你是一名中文商务沟通专家。请把以下邮件草稿润色得专业、礼貌、条理清晰，保持原意。',
      '语气：{{tone}}',
      '草稿：',
      '{{draft}}',
      '',
      '直接输出润色后的邮件正文（含称呼与结尾），不要解释。',
    ].join('\n'),
    inputSchema: {
      draft: { type: 'text', label: '邮件草稿', required: true },
      tone: {
        type: 'select',
        label: '语气',
        required: false,
        options: ['正式', '友好', '简洁', '诚恳致歉'],
      },
    },
    outputSchema: {},
    recommendedModels: CLOUD,
    routePolicy: route('balanced'),
  },
  {
    slug: 'weekly-report',
    title: '周报生成',
    description: '根据本周要点与下周计划，自动生成结构清晰的工作周报。',
    category: 'office',
    promptTemplate: [
      '你是一名职场写作助手。请根据以下要点生成一份条理清晰的工作周报。',
      '岗位/项目：{{role}}',
      '本周完成：{{done}}',
      '下周计划：{{plan}}',
      '',
      '请只返回 JSON，形如 {"thisWeek":["..."],"nextWeek":["..."],"risks":["..."]}。',
    ].join('\n'),
    inputSchema: {
      role: { type: 'string', label: '岗位/项目', required: false },
      done: { type: 'text', label: '本周完成要点', required: true },
      plan: { type: 'text', label: '下周计划要点', required: false },
    },
    outputSchema: {
      thisWeek: { type: 'array', item_type: 'string' },
      nextWeek: { type: 'array', item_type: 'string' },
      risks: { type: 'array', item_type: 'string' },
    },
    recommendedModels: CLOUD,
    routePolicy: route('cheap'),
  },
  {
    slug: 'bad-review-reply',
    title: '差评回复',
    description: '针对用户差评生成真诚、专业、可平息情绪的客服回复建议。',
    category: 'customer-service',
    featured: true,
    promptTemplate: [
      '你是一名经验丰富的客服主管。请针对下面的差评，给出 3 条不同风格的回复建议。',
      '商品/服务：{{product}}',
      '用户差评：{{review}}',
      '',
      '要求：真诚、不甩锅、给出具体解决方案；避免模板化套话。',
      '请只返回 JSON，形如 {"replies":["...","...","..."]}。',
    ].join('\n'),
    inputSchema: {
      product: { type: 'string', label: '商品/服务', required: false },
      review: { type: 'text', label: '用户差评内容', required: true },
    },
    outputSchema: {
      replies: { type: 'array', item_type: 'string' },
    },
    recommendedModels: CLOUD,
    routePolicy: route('quality'),
  },
]
