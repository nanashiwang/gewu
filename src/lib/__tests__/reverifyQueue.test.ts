import { describe, expect, it, vi } from 'vitest'
import {
  dequeueReverifyJobWithClient,
  enqueueReverifyJobWithClient,
  normalizeReverifyJob,
  releaseReverifyDedupeWithClient,
} from '@/lib/reverifyQueue'

function fakeRedis() {
  const store = new Map<string, string>()
  const queue: string[] = []
  return {
    set: vi.fn(async (key: string, value: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && store.has(key)) return null
      store.set(key, value)
      return 'OK'
    }),
    rPush: vi.fn(async (_key: string, value: string) => {
      queue.push(value)
      return queue.length
    }),
    lPop: vi.fn(async () => queue.shift() || null),
    del: vi.fn(async (key: string) => {
      store.delete(key)
      return 1
    }),
  }
}

describe('reverifyQueue — 失败库私人台账复验队列', () => {
  it('按 failureCaseId + userId 去重，避免重复塞入批量复验', async () => {
    const redis = fakeRedis()
    const job = {
      failureCaseId: 'failure-1',
      userId: 'user-1',
      candidateRunIds: ['run-1'],
      adapterIds: ['adapter-1'],
      enqueuedAt: '2026-07-08T00:00:00.000Z',
      reason: 'manual' as const,
    }

    await expect(enqueueReverifyJobWithClient(redis, job)).resolves.toEqual({ enqueued: true })
    await expect(enqueueReverifyJobWithClient(redis, job)).resolves.toEqual({
      enqueued: false,
      reason: 'duplicate',
    })
    expect(redis.rPush).toHaveBeenCalledTimes(1)
  })

  it('出队会清洗候选运行和 Adapter ID，保持私人台账复验输入可控', async () => {
    const redis = fakeRedis()
    await enqueueReverifyJobWithClient(redis, {
      failureCaseId: ' failure-1 ',
      userId: ' user-1 ',
      candidateRunIds: ['run-1', 'run-1', '', ' run-2 '],
      adapterIds: ['adapter-1', 'adapter-1', ' adapter-2 '],
      enqueuedAt: '2026-07-08T00:00:00.000Z',
      reason: 'manual',
    })

    await expect(dequeueReverifyJobWithClient(redis)).resolves.toEqual({
      failureCaseId: 'failure-1',
      userId: 'user-1',
      candidateRunIds: ['run-1', 'run-2'],
      adapterIds: ['adapter-1', 'adapter-2'],
      enqueuedAt: '2026-07-08T00:00:00.000Z',
      reason: 'manual',
    })
    await expect(dequeueReverifyJobWithClient(redis)).resolves.toBeNull()
  })

  it('失败后释放去重键，允许用户再次发起复验', async () => {
    const redis = fakeRedis()
    const job = {
      failureCaseId: 'failure-1',
      userId: 'user-1',
      candidateRunIds: ['run-1'],
      adapterIds: [],
      enqueuedAt: '2026-07-08T00:00:00.000Z',
      reason: 'manual' as const,
    }

    await enqueueReverifyJobWithClient(redis, job)
    await releaseReverifyDedupeWithClient(redis, job)
    await expect(enqueueReverifyJobWithClient(redis, job)).resolves.toEqual({ enqueued: true })
    expect(redis.rPush).toHaveBeenCalledTimes(2)
  })

  it('最多保留 100 个候选 ID，避免单个失败案例撑爆队列消息', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `run-${i}`)
    const normalized = normalizeReverifyJob({
      failureCaseId: 'failure-1',
      userId: 'user-1',
      candidateRunIds: ids,
      adapterIds: ids,
      enqueuedAt: '2026-07-08T00:00:00.000Z',
      reason: 'triage',
    })

    expect(normalized.candidateRunIds).toHaveLength(100)
    expect(normalized.adapterIds).toHaveLength(100)
  })
})
