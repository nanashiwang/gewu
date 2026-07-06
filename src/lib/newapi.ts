// 模型网关（OpenAI 兼容）客户端。开发未配网关时走 mock；生产缺网关必须 fail-closed。

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

export interface GatewayMetadata {
  runId?: string
  skillId?: string
  skillVersionId?: string
  skillVersion?: string
  source?: string
}

interface RunOpts {
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  apiKey?: string // 用户绑定 Key 优先于全局
  gateway?: { baseUrl?: string; apiKey?: string } // 后台部署设置优先，env 仅兜底
  metadata?: GatewayMetadata // 透传给网关用于关联调用日志（产品文档 §12.4）
}

export class NewApiError extends Error {
  status: number
  constructor(msg: string, status = 500) {
    super(msg)
    this.status = status
    this.name = 'NewApiError'
  }
}

const SECRET_TEXT_RE = /(sk-[A-Za-z0-9/_+\-=]{8,}|Bearer\s+[A-Za-z0-9._~+/\-=]{8,}|enc:v1:[A-Za-z0-9._~+/\-=]+)/g

function redactLiteral(text: string, value: string): string {
  const secret = value.trim()
  if (!secret || secret.length < 8) return text
  return text.split(secret).join('<redacted>')
}

export function redactGatewayErrorText(text: string, extraSecrets: string[] = []): string {
  let out = String(text || '').replace(SECRET_TEXT_RE, '<redacted>')
  for (const secret of [process.env.MODEL_GATEWAY_KEY || '', ...extraSecrets]) out = redactLiteral(out, secret)
  return out
}

// 构造透传给网关的 metadata 请求头（X-YH-*）
function metadataHeaders(m?: GatewayMetadata): Record<string, string> {
  if (!m) return {}
  const h: Record<string, string> = { 'X-YH-Source': m.source || 'hengshu' }
  if (m.runId) h['X-YH-Run-ID'] = m.runId
  if (m.skillId) h['X-YH-Skill-ID'] = String(m.skillId)
  if (m.skillVersionId) h['X-YH-Skill-Version-ID'] = String(m.skillVersionId)
  if (m.skillVersion) h['X-YH-Skill-Version'] = m.skillVersion
  return h
}

export async function chatCompletion(opts: RunOpts): Promise<NewApiResult> {
  const baseUrl = (opts.gateway?.baseUrl || process.env.MODEL_GATEWAY_BASE_URL)?.replace(/\/$/, '')
  const apiKey = opts.apiKey || opts.gateway?.apiKey || process.env.MODEL_GATEWAY_KEY
  const start = Date.now()

  // 未配置网关 → 开发 mock 回退；生产 fail-closed，避免公网用户拿到模拟输出还被计入运行/口碑。
  if (!baseUrl || !apiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new NewApiError('模型网关未配置，生产环境禁止 mock 运行', 503)
    }
    return mockCompletion(opts, start)
  }

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...metadataHeaders(opts.metadata),
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
    throw new NewApiError(`模型网关 ${res.status}: ${redactGatewayErrorText(errText.slice(0, 300), [apiKey])}`, res.status)
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
    `[MOCK] 未配置模型网关（后台部署设置或 MODEL_GATEWAY_BASE_URL / MODEL_GATEWAY_KEY 为空），以下为模拟输出。\n\n` +
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
