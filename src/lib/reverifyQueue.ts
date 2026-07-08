import type { Payload } from 'payload'
import { createClient } from 'redis'

const QUEUE_KEY = 'hs:reverify:queue'
const DEDUPE_PREFIX = 'hs:reverify:dedupe:'
const DEFAULT_DEDUPE_SECONDS = 6 * 60 * 60

export interface ReverifyJob {
  failureCaseId: string
  userId: string
  candidateRunIds: string[]
  adapterIds: string[]
  enqueuedAt: string
  reason: 'manual' | 'triage'
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

function dedupeKey(job: Pick<ReverifyJob, 'failureCaseId' | 'userId'>): string {
  return `${DEDUPE_PREFIX}${job.failureCaseId}:${job.userId}`
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
    socket: { reconnectStrategy: false, connectTimeout: 1000 },
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

function cleanIds(values: unknown[]): string[] {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 100)
}

export function normalizeReverifyJob(job: ReverifyJob): ReverifyJob {
  return {
    failureCaseId: String(job.failureCaseId || '').trim(),
    userId: String(job.userId || '').trim(),
    candidateRunIds: cleanIds(job.candidateRunIds || []),
    adapterIds: cleanIds(job.adapterIds || []),
    enqueuedAt: job.enqueuedAt || new Date().toISOString(),
    reason: job.reason || 'manual',
  }
}

export async function enqueueReverifyJobWithClient(
  client: RedisClientLike,
  job: ReverifyJob,
  dedupeSeconds = DEFAULT_DEDUPE_SECONDS,
): Promise<{ enqueued: boolean; reason?: 'duplicate' }> {
  const normalized = normalizeReverifyJob(job)
  const ok = await client.set(dedupeKey(normalized), '1', { NX: true, EX: dedupeSeconds })
  if (ok !== 'OK') return { enqueued: false, reason: 'duplicate' }
  await client.rPush(QUEUE_KEY, JSON.stringify(normalized))
  return { enqueued: true }
}

export async function dequeueReverifyJobWithClient(client: RedisClientLike): Promise<ReverifyJob | null> {
  const raw = await client.lPop(QUEUE_KEY)
  if (!raw) return null
  try {
    const job = normalizeReverifyJob(JSON.parse(raw) as ReverifyJob)
    if (!job.failureCaseId || !job.userId) return null
    return job
  } catch {
    return null
  }
}

export async function releaseReverifyDedupeWithClient(client: RedisClientLike, job: Pick<ReverifyJob, 'failureCaseId' | 'userId'>): Promise<void> {
  await client.del(dedupeKey(job))
}

export async function enqueueReverifyJob(
  payload: Payload,
  args: Omit<ReverifyJob, 'enqueuedAt' | 'reason'> & { reason?: ReverifyJob['reason'] },
): Promise<{ enqueued: boolean; skipped?: 'redis_not_configured' | 'duplicate' | 'redis_error' }> {
  const url = redisUrl()
  if (!url) return { enqueued: false, skipped: 'redis_not_configured' }
  try {
    const client = await getRedisClient(url)
    const res = await enqueueReverifyJobWithClient(client, {
      ...args,
      reason: args.reason || 'manual',
      enqueuedAt: new Date().toISOString(),
    })
    if (!res.enqueued) return { enqueued: false, skipped: 'duplicate' }
    return { enqueued: true }
  } catch (e) {
    payload.logger?.error(`reverify 入队失败 failure=${args.failureCaseId}: ${(e as Error).message}`)
    return { enqueued: false, skipped: 'redis_error' }
  }
}

export async function getReverifyRedisClient(): Promise<RedisClientLike | null> {
  const url = redisUrl()
  if (!url) return null
  return getRedisClient(url)
}

export async function resetReverifyQueueRedisForTests(): Promise<void> {
  const client = redisClient
  redisClient = null
  redisConnectPromise = null
  redisClientUrl = ''
  await client?.quit?.().catch(() => undefined)
}
