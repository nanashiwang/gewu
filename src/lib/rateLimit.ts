import { createHash } from 'crypto'
import type { Payload } from 'payload'
import { createClient } from 'redis'

const DEFAULT_WINDOW_SECONDS = 60

type RedisClientLike = {
  isOpen?: boolean
  connect?: () => Promise<unknown>
  quit?: () => Promise<unknown>
  on?: (event: 'error', listener: (err: Error) => void) => unknown
  eval: (script: string, opts: { keys: string[]; arguments: string[] }) => Promise<unknown>
}

let redisClient: RedisClientLike | null = null
let redisConnectPromise: Promise<RedisClientLike> | null = null
let redisClientUrl = ''

const FIXED_WINDOW_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end
local ttl = redis.call("TTL", KEYS[1])
if current <= tonumber(ARGV[1]) then
  return {1, current, ttl}
end
return {0, current, ttl}
`

export interface RunRateLimitResult {
  allowed: boolean
  backend: 'redis' | 'db' | 'unavailable'
  limit: number
  count?: number
  resetSeconds?: number
  unavailable?: boolean
  error?: string
}

function redisUrl(): string {
  return process.env.REDIS_URL?.trim() || ''
}

export function runRateLimitKey(userId: string, windowSeconds = DEFAULT_WINDOW_SECONDS): string {
  const digest = createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)
  return `gw:rl:run:${windowSeconds}:${digest}`
}

export function fixedRateLimitKey(scope: string, subject: string, windowSeconds = DEFAULT_WINDOW_SECONDS): string {
  const safeScope = String(scope || 'generic').replace(/[^a-z0-9:_-]/gi, '_').slice(0, 48)
  const digest = createHash('sha256').update(String(subject)).digest('hex').slice(0, 32)
  return `gw:rl:${safeScope}:${windowSeconds}:${digest}`
}

async function getRedisClient(url: string): Promise<RedisClientLike> {
  if (redisClient && redisClientUrl === url && redisClient.isOpen) return redisClient

  if (redisClient && (redisClientUrl !== url || redisClient.isOpen === false)) {
    redisClient.quit?.().catch(() => undefined)
    redisClient = null
    redisConnectPromise = null
  }

  if (redisConnectPromise) return redisConnectPromise

  const client = createClient({
    url,
    socket: {
      reconnectStrategy: false,
      connectTimeout: 1000,
    },
  }) as unknown as RedisClientLike
  client.on?.('error', () => undefined)

  redisClientUrl = url
  redisConnectPromise = (async () => {
    await client.connect?.()
    redisClient = client
    redisConnectPromise = null
    return client
  })().catch((e) => {
    redisClient = null
    redisConnectPromise = null
    throw e
  })

  return redisConnectPromise
}

function asNumber(v: unknown): number {
  if (typeof v === 'bigint') return Number(v)
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function parseRedisRateLimitResult(raw: unknown, limit: number): RunRateLimitResult {
  const arr = Array.isArray(raw) ? raw : []
  const allowed = asNumber(arr[0]) === 1
  const count = Math.max(0, asNumber(arr[1]))
  const ttl = Math.max(0, asNumber(arr[2]))
  return {
    allowed,
    backend: 'redis',
    limit,
    count,
    resetSeconds: ttl,
  }
}

export async function consumeRedisRunRateLimit(
  client: RedisClientLike,
  userId: string,
  limit: number,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
): Promise<RunRateLimitResult> {
  return consumeRedisFixedWindow(client, runRateLimitKey(userId, windowSeconds), limit, windowSeconds)
}

export async function consumeRedisFixedWindow(
  client: RedisClientLike,
  key: string,
  limit: number,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
): Promise<RunRateLimitResult> {
  const raw = await client.eval(FIXED_WINDOW_SCRIPT, {
    keys: [key],
    arguments: [String(limit), String(windowSeconds)],
  })
  return parseRedisRateLimitResult(raw, limit)
}

async function checkDbRecentRuns(
  payload: Payload,
  userId: string,
  limit: number,
  windowSeconds: number,
): Promise<RunRateLimitResult> {
  const winStart = new Date(Date.now() - windowSeconds * 1000).toISOString()
  const recent = await payload.count({
    collection: 'skill-runs',
    where: {
      and: [{ user: { equals: userId } }, { createdAt: { greater_than_equal: winStart } }],
    },
    overrideAccess: true,
  })
  const count = recent.totalDocs || 0
  return {
    allowed: count < limit,
    backend: 'db',
    limit,
    count,
    resetSeconds: windowSeconds,
  }
}

export async function consumeRunRateLimit(args: {
  payload: Payload
  userId: string
  limit: number
  platformPaid: boolean
  windowSeconds?: number
}): Promise<RunRateLimitResult> {
  const windowSeconds = args.windowSeconds || DEFAULT_WINDOW_SECONDS
  const url = redisUrl()

  if (url) {
    try {
      const client = await getRedisClient(url)
      return await consumeRedisRunRateLimit(client, args.userId, args.limit, windowSeconds)
    } catch (e) {
      args.payload.logger?.error(`Redis 运行限流不可用: ${(e as Error).message}`)
      // 平台代付保护真钱成本：Redis 配了但不可用时 fail-closed；BYOK 可降级 DB 窗口。
      if (args.platformPaid) {
        return {
          allowed: false,
          backend: 'unavailable',
          limit: args.limit,
          unavailable: true,
          error: 'redis_unavailable',
        }
      }
    }
  } else if (args.platformPaid && process.env.NODE_ENV === 'production') {
    return {
      allowed: false,
      backend: 'unavailable',
      limit: args.limit,
      unavailable: true,
      error: 'redis_not_configured',
    }
  }

  try {
    return await checkDbRecentRuns(args.payload, args.userId, args.limit, windowSeconds)
  } catch (e) {
    args.payload.logger?.error(`DB 运行限流不可用: ${(e as Error).message}`)
    if (args.platformPaid) {
      return {
        allowed: false,
        backend: 'unavailable',
        limit: args.limit,
        unavailable: true,
        error: 'db_rate_limit_unavailable',
      }
    }
    return {
      allowed: true,
      backend: 'unavailable',
      limit: args.limit,
      unavailable: true,
      error: 'db_rate_limit_bypassed_for_byok',
    }
  }
}

export async function consumeStrictRedisRateLimit(args: {
  payload: Payload
  scope: string
  subject: string
  limit: number
  windowSeconds?: number
}): Promise<RunRateLimitResult> {
  const windowSeconds = args.windowSeconds || DEFAULT_WINDOW_SECONDS
  const url = redisUrl()
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      return {
        allowed: false,
        backend: 'unavailable',
        limit: args.limit,
        unavailable: true,
        error: 'redis_not_configured',
      }
    }
    return { allowed: true, backend: 'unavailable', limit: args.limit, unavailable: true, error: 'redis_not_configured' }
  }

  try {
    const client = await getRedisClient(url)
    return await consumeRedisFixedWindow(
      client,
      fixedRateLimitKey(args.scope, args.subject, windowSeconds),
      args.limit,
      windowSeconds,
    )
  } catch (e) {
    args.payload.logger?.error(`Redis 严格限流不可用 scope=${args.scope}: ${(e as Error).message}`)
    if (process.env.NODE_ENV === 'production') {
      return {
        allowed: false,
        backend: 'unavailable',
        limit: args.limit,
        unavailable: true,
        error: 'redis_unavailable',
      }
    }
    return { allowed: true, backend: 'unavailable', limit: args.limit, unavailable: true, error: 'redis_unavailable' }
  }
}

export async function resetRateLimitRedisForTests(): Promise<void> {
  const client = redisClient
  redisClient = null
  redisConnectPromise = null
  redisClientUrl = ''
  await client?.quit?.().catch(() => undefined)
}
