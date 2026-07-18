import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'

export const RELAY_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const
export type RelayProtocol = (typeof RELAY_PROTOCOLS)[number]

export const RELAY_CONTACT_TYPES = ['email', 'qq', 'wechat', 'telegram', 'discord', 'other'] as const
export type RelayContactType = (typeof RELAY_CONTACT_TYPES)[number]

export const RELAY_INTERVAL_HOURS = [6, 12, 24, 72, 168] as const

export interface RelayContactInput {
  type: RelayContactType
  value: string
  isPublic: boolean
}

export interface RelaySiteInput {
  name: string
  websiteUrl: string
  apiBaseUrl: string
  description: string
  protocol: RelayProtocol
  model: string
  mode: 'quick' | 'standard' | 'full'
  contacts: RelayContactInput[]
  scheduleEnabled: boolean
  scheduleIntervalHours: number
  apiKey?: string
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.test', '.invalid']

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '::' || value === '::1') return true
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (/^fe[89ab]/.test(value)) return true
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length)
    return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true
  }
  return false
}

export function isBlockedRelayHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  const family = isIP(host)
  if (family === 4) return isPrivateIpv4(host)
  if (family === 6) return isPrivateIpv6(host)
  return !host.includes('.')
}

export function normalizePublicHttpUrl(raw: unknown, label: string): string {
  const value = String(raw || '').trim()
  if (!value) throw new Error(`${label}不能为空`)
  if (value.length > 2048) throw new Error(`${label}过长`)

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}格式无效`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}只支持 http/https`)
  if (url.username || url.password) throw new Error(`${label}不能包含用户名或密码`)
  if (isBlockedRelayHostname(url.hostname)) throw new Error(`${label}不能指向本机、内网或保留地址`)
  url.hash = ''
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString()
}

export function normalizeRelayApiUrl(raw: unknown): string {
  const normalized = normalizePublicHttpUrl(raw, 'API 地址')
  const url = new URL(normalized)
  if (url.protocol !== 'https:') throw new Error('API 地址必须使用 HTTPS，以免 API Key 明文传输')
  if (url.search) throw new Error('API 地址不能包含查询参数')
  return url.toString()
}

function normalizeContact(value: unknown): RelayContactInput | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const type = String(input.type || '').trim().toLowerCase() as RelayContactType
  const contactValue = String(input.value || '').trim()
  if (!RELAY_CONTACT_TYPES.includes(type)) throw new Error('联系方式类型无效')
  if (contactValue.length < 2 || contactValue.length > 200 || /[\u0000-\u001f\u007f]/.test(contactValue)) {
    throw new Error('联系方式长度或内容无效')
  }
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactValue)) throw new Error('邮箱格式无效')
  return { type, value: contactValue, isPublic: input.isPublic === true }
}

export function normalizeRelaySiteInput(raw: unknown, options: { partial?: boolean } = {}): Partial<RelaySiteInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请求体必须是对象')
  const body = raw as Record<string, unknown>
  const partial = options.partial === true
  const out: Partial<RelaySiteInput> = {}

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = String(body.name || '').trim()
    if (name.length < 2 || name.length > 80) throw new Error('中转站名称需为 2–80 个字符')
    out.name = name
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'websiteUrl')) {
    out.websiteUrl = normalizePublicHttpUrl(body.websiteUrl, '官网地址')
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'apiBaseUrl')) {
    out.apiBaseUrl = normalizeRelayApiUrl(body.apiBaseUrl)
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'description')) {
    const description = String(body.description || '').trim()
    if (description.length > 2000) throw new Error('简介不能超过 2000 个字符')
    out.description = description
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'protocol')) {
    const protocol = String(body.protocol || '').trim().toLowerCase() as RelayProtocol
    if (!RELAY_PROTOCOLS.includes(protocol)) throw new Error('检测协议无效')
    out.protocol = protocol
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'model')) {
    const model = String(body.model || '').trim()
    if (model.length < 2 || model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('模型名称无效')
    out.model = model
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'mode')) {
    const mode = String(body.mode || 'standard').trim().toLowerCase() as RelaySiteInput['mode']
    if (!['quick', 'standard', 'full'].includes(mode)) throw new Error('检测模式无效')
    out.mode = mode
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'contacts')) {
    if (body.contacts == null) throw new Error('至少填写 1 个有效联系方式')
    if (!Array.isArray(body.contacts)) throw new Error('联系方式必须是数组')
    if (body.contacts.length > 5) throw new Error('最多填写 5 个联系方式')
    out.contacts = body.contacts.map(normalizeContact).filter(Boolean) as RelayContactInput[]
    if (out.contacts.length === 0) throw new Error('至少填写 1 个有效联系方式')
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'scheduleEnabled')) {
    out.scheduleEnabled = body.scheduleEnabled === true
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'scheduleIntervalHours')) {
    const interval = Number(body.scheduleIntervalHours || 24)
    if (!RELAY_INTERVAL_HOURS.includes(interval as (typeof RELAY_INTERVAL_HOURS)[number])) {
      throw new Error('定时检测间隔无效')
    }
    out.scheduleIntervalHours = interval
  }
  if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
    const apiKey = String(body.apiKey || '').trim()
    if (apiKey && (apiKey.length < 8 || apiKey.length > 500 || /[\u0000-\u001f\u007f]/.test(apiKey))) {
      throw new Error('API Key 长度或内容无效')
    }
    out.apiKey = apiKey
  }
  return out
}

export function createRelayClaimToken(): string {
  return randomBytes(24).toString('base64url')
}

export function createRelaySlug(name: string, apiBaseUrl: string): string {
  const hostname = new URL(apiBaseUrl).hostname
  const base = `${name}-${hostname}`
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'relay'
  return `${base}-${randomBytes(4).toString('hex')}`
}

export function relayClaimDomain(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).hostname.toLowerCase().replace(/\.$/, '')
}

export function relayClaimRecord(domain: string, token: string) {
  return {
    name: `_gewu-verify.${domain}`,
    value: `gewu-site-verification=${token}`,
  }
}

export function nextRelayCheckAt(intervalHours: number, from = new Date()): string {
  const safe = RELAY_INTERVAL_HOURS.includes(intervalHours as (typeof RELAY_INTERVAL_HOURS)[number]) ? intervalHours : 24
  return new Date(from.getTime() + safe * 60 * 60 * 1000).toISOString()
}

export function relayGrade(score: unknown): string {
  const value = Number(score)
  if (!Number.isFinite(value)) return '—'
  if (value >= 90) return 'A'
  if (value >= 80) return 'B'
  if (value >= 70) return 'C'
  if (value >= 60) return 'D'
  return 'F'
}

export function relationId(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'object') return (value as any).id ? String((value as any).id) : null
  return String(value)
}

const SAFE_RELAY_INPUT_ERRORS = [
  /不能为空$/,
  /过长$/,
  /格式无效$/,
  /只支持 http\/https$/,
  /不能包含用户名或密码$/,
  /不能指向本机、内网或保留地址$/,
  /^API 地址必须使用 HTTPS/,
  /^API 地址不能包含查询参数$/,
  /^中转站名称需为/,
  /^简介不能超过/,
  /^检测协议无效$/,
  /^模型名称无效$/,
  /^检测模式无效$/,
  /^联系方式/,
  /^邮箱格式无效$/,
  /^最多填写/,
  /^至少填写 1 个有效联系方式$/,
  /^定时检测间隔无效$/,
  /^API Key 长度或内容无效$/,
  /^请求体必须是对象$/,
]

export function relayInputErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return SAFE_RELAY_INPUT_ERRORS.some((pattern) => pattern.test(message)) ? message : '中转站资料无效'
}
