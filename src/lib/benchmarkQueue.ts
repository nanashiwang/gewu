import type { Payload } from 'payload'
import { createClient } from 'redis'

const QUEUE_KEY = 'gw:benchmark:queue'
const DEDUPE_PREFIX = 'gw:benchmark:dedupe:'
const DEFAULT_DEDUPE_SECONDS = 24 * 60 * 60

export interface BenchmarkJob {
  skillId: string
  slug?: string
  enqueuedAt: string
  reason: 'published' | 'manual'
}

type RedisClientLike = {
  isOpen?: boolean
  connect?: () => Promise<unknown>
  quit?: () => Promise<unknown>
  on?: (event: 'error', listener: (err: Error) => void) => unknown
  set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>
  rPush: (key: string, value: string) => Promise<unknown>
  lPop: (key: string) => Promise<string | null>
  del: (key: string) => Promise<unknown>
}

let redisClient: RedisClientLike | null = null
let redisConnectPromise: Promise<RedisClientLike> | null = null
let redisClientUrl = ''

function redisUrl(): string {
  return process.env.REDIS_URL?.trim() || ''
}

function dedupeKey(skillId: string): string {
  return `${DEDUPE_PREFIX}${skillId}`
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

export async function enqueueBenchmarkJobWithClient(
  client: RedisClientLike,
  job: BenchmarkJob,
  dedupeSeconds = DEFAULT_DEDUPE_SECONDS,
): Promise<{ enqueued: boolean; reason?: 'duplicate' }> {
  const ok = await client.set(dedupeKey(job.skillId), '1', { NX: true, EX: dedupeSeconds })
  if (ok !== 'OK') return { enqueued: false, reason: 'duplicate' }
  await client.rPush(QUEUE_KEY, JSON.stringify(job))
  return { enqueued: true }
}

export async function dequeueBenchmarkJobWithClient(client: RedisClientLike): Promise<BenchmarkJob | null> {
  const raw = await client.lPop(QUEUE_KEY)
  if (!raw) return null
  try {
    const job = JSON.parse(raw) as BenchmarkJob
    if (!job?.skillId || !job?.enqueuedAt) return null
    return job
  } catch {
    return null
  }
}

export async function releaseBenchmarkDedupeWithClient(client: RedisClientLike, skillId: string): Promise<void> {
  await client.del(dedupeKey(skillId))
}

export async function enqueueBenchmarkJob(
  payload: Payload,
  args: { skillId: string; slug?: string; reason?: BenchmarkJob['reason'] },
): Promise<{ enqueued: boolean; skipped?: 'redis_not_configured' | 'duplicate' | 'redis_error' }> {
  const url = redisUrl()
  if (!url) return { enqueued: false, skipped: 'redis_not_configured' }
  try {
    const client = await getRedisClient(url)
    const res = await enqueueBenchmarkJobWithClient(client, {
      skillId: args.skillId,
      slug: args.slug,
      reason: args.reason || 'published',
      enqueuedAt: new Date().toISOString(),
    })
    if (!res.enqueued) return { enqueued: false, skipped: 'duplicate' }
    return { enqueued: true }
  } catch (e) {
    payload.logger?.error(`benchmark 入队失败 skill=${args.skillId}: ${(e as Error).message}`)
    return { enqueued: false, skipped: 'redis_error' }
  }
}

export async function getBenchmarkRedisClient(): Promise<RedisClientLike | null> {
  const url = redisUrl()
  if (!url) return null
  return getRedisClient(url)
}

export async function resetBenchmarkQueueRedisForTests(): Promise<void> {
  const client = redisClient
  redisClient = null
  redisConnectPromise = null
  redisClientUrl = ''
  await client?.quit?.().catch(() => undefined)
}
