// 模型网关（OpenAI 兼容）客户端。无 Key 时走 mock 回退，保证骨架可跑通。

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface NewApiResult {
  text: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  mocked: boolean
  raw?: unknown
}

interface RunOpts {
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  apiKey?: string // 用户绑定 Key 优先于全局
}

export class NewApiError extends Error {
  status: number
  constructor(msg: string, status = 500) {
    super(msg)
    this.status = status
    this.name = 'NewApiError'
  }
}

export async function chatCompletion(opts: RunOpts): Promise<NewApiResult> {
  const baseUrl = process.env.MODEL_GATEWAY_BASE_URL?.replace(/\/$/, '')
  const apiKey = opts.apiKey || process.env.MODEL_GATEWAY_KEY
  const start = Date.now()

  // 未配置网关 → mock 回退
  if (!baseUrl || !apiKey) {
    return mockCompletion(opts, start)
  }

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
  })

  const latencyMs = Date.now() - start
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new NewApiError(`模型网关 ${res.status}: ${errText.slice(0, 300)}`, res.status)
  }

  const data: any = await res.json()
  const text: string = data?.choices?.[0]?.message?.content ?? ''
  const usage = data?.usage || {}
  const promptTokens = usage.prompt_tokens ?? estimateTokens(opts.messages.map((m) => m.content).join('\n'))
  const completionTokens = usage.completion_tokens ?? estimateTokens(text)
  return {
    text,
    model: data?.model || opts.model,
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    latencyMs,
    mocked: false,
    raw: data,
  }
}

// 粗略 token 估算：中英文混合约 2.5 字符/token
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 2.5)
}

function mockCompletion(opts: RunOpts, start: number): NewApiResult {
  const userMsg = opts.messages.find((m) => m.role === 'user')?.content || ''
  const text =
    `[MOCK] 未配置模型网关（MODEL_GATEWAY_BASE_URL / MODEL_GATEWAY_KEY 为空），以下为模拟输出。\n\n` +
    `· 路由模型：${opts.model}\n` +
    `· 已渲染 Prompt（前 240 字）：\n${userMsg.slice(0, 240)}\n\n` +
    `配置真实网关后，此处将返回模型的实际输出。`
  const promptTokens = estimateTokens(opts.messages.map((m) => m.content).join('\n'))
  const completionTokens = estimateTokens(text)
  return {
    text,
    model: opts.model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    latencyMs: Date.now() - start + 120,
    mocked: true,
  }
}
