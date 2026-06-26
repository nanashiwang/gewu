// 第一批官方 Skill 种子数据（Hengshu Skill Spec v1：system + user 双段）

export interface SeedSkill {
  slug: string
  title: string
  description: string
  category: string // 对应 SKILL_CATEGORIES 的 slug
  featured?: boolean
  systemPrompt: string // Spec prompt.system
  promptTemplate: string // Spec prompt.user_template（含 {{变量}}）
  license?: string
  inputSchema: Record<string, any>
  outputSchema: Record<string, any>
  recommendedModels: { cloud: string[]; local: string[] }
  routePolicy: { default: string; strategies: Record<string, string[]> }
  examples?: Array<{ input: Record<string, any>; output: any }>
}

// 当前模型网关（cn.meta-api.vip）可用模型
const M = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  gptMini: 'gpt-5.4-mini',
  gpt: 'gpt-5.5',
}

const CLOUD = { cloud: [M.haiku, M.sonnet, M.gptMini], local: ['qwen2.5:14b', 'llama3.1:8b'] }
const LICENSE = 'CC-BY-NC-4.0'

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
    license: LICENSE,
    systemPrompt: '你是一名资深小红书内容编辑，擅长写有点击欲、不违规的标题。',
    promptTemplate: [
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
    examples: [
      {
        input: { topic: '秋季护肤', audience: '30岁女性', style: '专业' },
        output: { titles: ['秋天护肤别乱来，这3步比贵妇霜更重要'], reason: '突出季节痛点和实用价值' },
      },
    ],
  },
  {
    slug: 'meeting-minutes',
    title: '会议纪要整理',
    description: '把零散的会议记录整理为结构化纪要：议题、结论、待办与负责人。',
    category: 'office',
    featured: true,
    license: LICENSE,
    systemPrompt: '你是一名专业的会议秘书，善于把零散记录整理成规范纪要。',
    promptTemplate: [
      '请把下面的会议记录整理为规范纪要。',
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
    examples: [
      {
        input: { topic: '周会', notes: '小张说登录页要改；下周一上线；老王负责后端。' },
        output: {
          summary: '确认登录页改版并定档下周一上线',
          decisions: ['登录页改版'],
          todos: [{ task: '后端联调', owner: '老王', due: '下周一' }],
        },
      },
    ],
  },
  {
    slug: 'email-polish',
    title: '邮件润色',
    description: '把口语化或粗糙的邮件草稿润色为得体、专业的中文商务邮件。',
    category: 'office',
    license: LICENSE,
    systemPrompt: '你是一名中文商务沟通专家，擅长把粗糙草稿润色为得体专业的邮件。',
    promptTemplate: [
      '请把以下邮件草稿润色得专业、礼貌、条理清晰，保持原意。',
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
    license: LICENSE,
    systemPrompt: '你是一名职场写作助手，擅长把零散要点整理成条理清晰的周报。',
    promptTemplate: [
      '请根据以下要点生成一份条理清晰的工作周报。',
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
    license: LICENSE,
    systemPrompt: '你是一名经验丰富的客服主管，回复真诚、不甩锅、给出具体方案。',
    promptTemplate: [
      '请针对下面的差评，给出 3 条不同风格的回复建议。',
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
    examples: [
      {
        input: { product: '无线耳机', review: '用了三天右耳就没声音了' },
        output: { replies: ['非常抱歉…立即为您换新或退款，请告知订单号。'] },
      },
    ],
  },
]
