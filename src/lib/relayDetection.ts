import type { Payload } from 'payload'
import { decryptSecret } from './secrets'
import { nextRelayCheckAt, relayGrade, relationId } from './relaySite'

const ACTIVE_CHECK_STATUSES = ['queued', 'running']
const CHECK_SUBMISSION_STALE_MS = 5 * 60 * 1000
const CHECK_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000
const REDACTED = '[REDACTED]'

export function relayCheckErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('尚未配置可用的 API Key')) return '中转站尚未配置可用的 API Key'
  if (message.includes('未返回有效任务 ID')) return '检测服务响应异常，请稍后重试'
  if (message.includes('已有检测任务正在运行') || message.includes('relay_checks_one_active_per_site_idx')) return '该中转站已有检测任务正在运行'
  return '检测任务提交失败，请稍后重试'
}

function redactRelaySecret(value: unknown, secret: string): unknown {
  if (!secret || secret.length < 4) return value
  if (typeof value === 'string') return value.split(secret).join(REDACTED)
  if (Array.isArray(value)) return value.map((item) => redactRelaySecret(item, secret))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key.split(secret).join(REDACTED),
        redactRelaySecret(item, secret),
      ]),
    )
  }
  return value
}

function isActiveCheckConflict(error: unknown): boolean {
  let current: any = error
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === '23505') return true
    if (String(current.message || '').includes('relay_checks_one_active_per_site_idx')) return true
    current = current.cause
  }
  return false
}

function checkAgeMs(check: any, now = new Date()): number {
  const createdAt = new Date(check?.createdAt || '').getTime()
  return Number.isFinite(createdAt) ? Math.max(0, now.getTime() - createdAt) : 0
}

function detectorBaseUrl(): string {
  const raw = process.env.DETECTOR_BASE_URL?.trim() || 'http://127.0.0.1:8765'
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('DETECTOR_BASE_URL 配置无效')
  return url.toString().replace(/\/+$/, '')
}

function detectorPublicUrl(): string {
  const raw = process.env.DETECTOR_PUBLIC_URL?.trim() || process.env.DETECTOR_BASE_URL?.trim() || 'http://127.0.0.1:8765'
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('DETECTOR_PUBLIC_URL 配置无效')
  return url.toString().replace(/\/+$/, '')
}

async function detectorFetch(path: string, init?: RequestInit, timeoutMs = 30_000) {
  const response = await fetch(`${detectorBaseUrl()}${path}`, {
    ...init,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let body: any = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`检测服务返回了无效响应（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const message = String(body?.detail || body?.error || `HTTP ${response.status}`).slice(0, 500)
    throw new Error(`检测服务拒绝请求：${message}`)
  }
  return body
}

export async function startRelayCheck(
  payload: Payload,
  site: any,
  options: { source: 'manual' | 'scheduled'; userId?: string },
) {
  const siteId = String(site.id)
  const active = await payload.count({
    collection: 'relay-checks' as any,
    where: { and: [{ site: { equals: siteId } }, { status: { in: ACTIVE_CHECK_STATUSES } }] },
    overrideAccess: true,
  })
  if (active.totalDocs > 0) throw new Error('该中转站已有检测任务正在运行')

  const apiKey = decryptSecret(site.apiKeyEncrypted)
  if (!apiKey) throw new Error('中转站尚未配置可用的 API Key')

  let created: any
  try {
    created = await payload.create({
      collection: 'relay-checks' as any,
      overrideAccess: true,
      data: {
        site: siteId,
        triggeredBy: options.userId || undefined,
        source: options.source,
        protocol: site.protocol,
        model: site.model,
        mode: site.mode || 'standard',
        status: 'queued',
      },
    }) as any
  } catch (error) {
    if (isActiveCheckConflict(error)) throw new Error('该中转站已有检测任务正在运行')
    throw error
  }

  try {
    const form = new FormData()
    form.set('base_url', String(site.apiBaseUrl))
    form.set('api_key', apiKey)
    form.set('model', String(site.model))
    form.set('mode', String(site.mode || 'standard'))
    const result = await detectorFetch(`/api/detect/${site.protocol}`, { method: 'POST', body: form }, 45_000)
    const jobId = String(result?.job_id || '')
    if (!jobId || !/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) throw new Error('检测服务未返回有效任务 ID')
    return await payload.update({
      collection: 'relay-checks' as any,
      id: created.id,
      overrideAccess: true,
      data: { detectorJobId: jobId, status: 'queued' },
    }) as any
  } catch (error) {
    await payload.update({
      collection: 'relay-checks' as any,
      id: created.id,
      overrideAccess: true,
      data: {
        status: 'error',
        error: String(redactRelaySecret((error as Error).message || '检测任务提交失败', apiKey)).slice(0, 1000),
        finishedAt: new Date().toISOString(),
      },
    }).catch(() => undefined)
    throw error
  }
}

function epochSecondsToIso(value: unknown): string | undefined {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined
}

export async function reconcileRelayCheck(payload: Payload, check: any) {
  const ageMs = checkAgeMs(check)
  if (!check.detectorJobId) {
    if (ageMs < CHECK_SUBMISSION_STALE_MS) return check
    return payload.update({
      collection: 'relay-checks' as any,
      id: check.id,
      overrideAccess: true,
      data: {
        status: 'error',
        error: '检测任务提交中断，未获得检测服务任务 ID，请重新发起检测',
        finishedAt: new Date().toISOString(),
      },
    })
  }
  if (ageMs >= CHECK_MAX_RUNTIME_MS) {
    return payload.update({
      collection: 'relay-checks' as any,
      id: check.id,
      overrideAccess: true,
      data: {
        status: 'error',
        error: '检测任务超过最大执行时间，请重新发起检测',
        finishedAt: new Date().toISOString(),
      },
    })
  }

  const status = await detectorFetch(`/api/status/${encodeURIComponent(String(check.detectorJobId))}`, undefined, 15_000)
  if (status.status === 'queued' || status.status === 'running') {
    return payload.update({
      collection: 'relay-checks' as any,
      id: check.id,
      overrideAccess: true,
      data: {
        status: status.status,
        startedAt: epochSecondsToIso(status.started_at) || check.startedAt,
      },
    })
  }

  const siteId = relationId(check.site)
  const site = siteId
    ? await payload.findByID({
        collection: 'relay-sites' as any,
        id: siteId,
        depth: 0,
        overrideAccess: true,
      }).catch(() => null) as any
    : null
  const apiKey = decryptSecret(site?.apiKeyEncrypted)

  if (status.status === 'error') {
    const finishedAt = epochSecondsToIso(status.finished_at) || new Date().toISOString()
    return payload.update({
      collection: 'relay-checks' as any,
      id: check.id,
      overrideAccess: true,
      data: {
        status: 'error',
        error: String(redactRelaySecret(status.error || '检测失败', apiKey)).slice(0, 1000),
        startedAt: epochSecondsToIso(status.started_at) || check.startedAt,
        finishedAt,
      },
    })
  }
  if (status.status !== 'done') throw new Error(`未知检测任务状态：${String(status.status)}`)

  const rawReport = await detectorFetch(`/api/result/${encodeURIComponent(String(check.detectorJobId))}.json`, undefined, 20_000)
  const score = Number(rawReport.total_score)
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return payload.update({
      collection: 'relay-checks' as any,
      id: check.id,
      overrideAccess: true,
      data: {
        status: 'error',
        error: '检测服务返回的报告得分无效，未写入站点质量档案',
        finishedAt: epochSecondsToIso(status.finished_at) || new Date().toISOString(),
      },
    })
  }

  const report = redactRelaySecret(rawReport, apiKey) as Record<string, any>

  const safeScore = score
  const startedAt = epochSecondsToIso(status.started_at) || check.startedAt || check.createdAt
  const finishedAt = epochSecondsToIso(status.finished_at) || new Date().toISOString()
  const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
  const verdict = String(report.verdict || 'unknown').slice(0, 80)
  const grade = relayGrade(safeScore)
  const resultUrl = `${detectorPublicUrl()}/r/${encodeURIComponent(String(check.detectorJobId))}`

  const updated = await payload.update({
    collection: 'relay-checks' as any,
    id: check.id,
    overrideAccess: true,
    data: {
      status: 'done',
      score: safeScore,
      grade,
      verdict,
      summary: String(report.summary || '').slice(0, 2000),
      resultUrl,
      startedAt,
      finishedAt,
      durationMs,
      report,
    },
  }) as any

  if (siteId) {
    await payload.update({
      collection: 'relay-sites' as any,
      id: siteId,
      overrideAccess: true,
      data: { lastCheckAt: finishedAt, lastScore: safeScore, lastGrade: grade, lastVerdict: verdict },
    })
  }
  return updated
}

export async function runRelayCheckCycle(payload: Payload, options: { maxReconcile?: number; maxSchedule?: number } = {}) {
  const summary = { reconciled: 0, submitted: 0, failed: 0 }
  const active = await payload.find({
    collection: 'relay-checks' as any,
    where: { status: { in: ACTIVE_CHECK_STATUSES } },
    sort: 'createdAt',
    limit: Math.max(1, options.maxReconcile || 50),
    depth: 0,
    overrideAccess: true,
  })
  for (const check of active.docs as any[]) {
    try {
      await reconcileRelayCheck(payload, check)
      summary.reconciled++
    } catch (error) {
      summary.failed++
      const pollFailures = Math.max(0, Number(check.pollFailures || 0)) + 1
      await payload.update({
        collection: 'relay-checks' as any,
        id: check.id,
        overrideAccess: true,
        data: pollFailures >= 3
          ? { status: 'error', pollFailures, error: '检测结果同步连续失败，请重新发起检测', finishedAt: new Date().toISOString() }
          : { pollFailures, error: `检测结果同步失败（${pollFailures}/3）` },
      }).catch(() => undefined)
      payload.logger?.error(`中转检测对账失败 check=${check.id}: ${(error as Error).message}`)
    }
  }

  const now = new Date()
  const due = await payload.find({
    collection: 'relay-sites' as any,
    where: {
      and: [
        { status: { equals: 'approved' } },
        { claimStatus: { in: ['verified', 'manual'] } },
        { scheduleEnabled: { equals: true } },
        { nextCheckAt: { less_than_equal: now.toISOString() } },
      ],
    },
    sort: 'nextCheckAt',
    limit: Math.max(1, options.maxSchedule || 10),
    depth: 0,
    overrideAccess: true,
  })
  for (const site of due.docs as any[]) {
    const nextCheckAt = nextRelayCheckAt(Number(site.scheduleIntervalHours || 24), now)
    try {
      await payload.update({ collection: 'relay-sites' as any, id: site.id, data: { nextCheckAt }, overrideAccess: true })
      await startRelayCheck(payload, site, { source: 'scheduled' })
      summary.submitted++
    } catch (error) {
      summary.failed++
      payload.logger?.error(`定时中转检测提交失败 site=${site.id}: ${(error as Error).message}`)
    }
  }
  return summary
}
