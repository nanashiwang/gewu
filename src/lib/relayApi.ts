import type { Payload } from 'payload'
import { getPayload } from 'payload'
import config from '@payload-config'
import { headers as nextHeaders } from 'next/headers'
import { consumeStrictRedisRateLimit } from './rateLimit'
import { relationId } from './relaySite'

export interface RelayActorContext {
  payload: Payload
  user: any
}

export function isRelayStaff(user: unknown): boolean {
  return Boolean(user && (user as any).accountStatus !== 'banned' && ['admin', 'reviewer'].includes(String((user as any).role || '')))
}

export function sameOriginMutationAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export async function relayActor(request: Request): Promise<RelayActorContext | Response> {
  if (!sameOriginMutationAllowed(request)) return Response.json({ error: '请求来源无效' }, { status: 403 })
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await nextHeaders() })
  if (!user) return Response.json({ error: '请先登录' }, { status: 401 })
  if ((user as any).accountStatus === 'banned') return Response.json({ error: '账号已被封禁' }, { status: 403 })
  return { payload, user }
}

export function isRelayActorResponse(value: RelayActorContext | Response): value is Response {
  return value instanceof Response
}

export async function enforceRelayRateLimit(
  payload: Payload,
  userId: string,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const result = await consumeStrictRedisRateLimit({ payload, scope: `relay:${scope}`, subject: userId, limit, windowSeconds })
  if (result.allowed) return null
  const wait = Math.max(1, result.resetSeconds || windowSeconds)
  return Response.json(
    { error: result.unavailable ? '安全限流服务暂不可用，请稍后重试' : `操作过于频繁，请在 ${wait} 秒后重试` },
    { status: result.unavailable ? 503 : 429, headers: { 'Retry-After': String(wait) } },
  )
}

export async function findRelayForActor(payload: Payload, id: string, user: any) {
  const site = await payload.findByID({
    collection: 'relay-sites' as any,
    id,
    depth: 1,
    overrideAccess: true,
  }).catch(() => null) as any
  if (!site) return { error: Response.json({ error: '中转站不存在' }, { status: 404 }) }
  if (!isRelayStaff(user) && relationId(site.owner) !== String(user.id)) {
    return { error: Response.json({ error: '无权操作该中转站' }, { status: 403 }) }
  }
  return { site }
}

export function relaySiteDto(site: any, viewer?: any) {
  const ownerId = relationId(site.owner)
  const privateView = Boolean(viewer && (isRelayStaff(viewer) || ownerId === String(viewer.id)))
  const publicContacts = Array.isArray(site.contacts)
    ? site.contacts
        .filter((contact: any) => privateView || (site.status === 'approved' && contact?.isPublic === true))
        .map((contact: any) => ({ type: contact.type, value: contact.value, isPublic: contact.isPublic === true }))
    : []
  const base: Record<string, unknown> = {
    id: site.id,
    slug: site.slug,
    name: site.name,
    websiteUrl: site.websiteUrl,
    apiBaseUrl: site.apiBaseUrl,
    description: site.description || '',
    contacts: publicContacts,
    protocol: site.protocol,
    model: site.model,
    mode: site.mode,
    status: site.status,
    claimStatus: site.claimStatus,
    claimDomain: site.claimDomain,
    scheduleEnabled: Boolean(site.scheduleEnabled),
    scheduleIntervalHours: Number(site.scheduleIntervalHours || 24),
    nextCheckAt: site.nextCheckAt || null,
    lastCheckAt: site.lastCheckAt || null,
    lastScore: typeof site.lastScore === 'number' ? site.lastScore : null,
    lastGrade: site.lastGrade || null,
    lastVerdict: site.lastVerdict || null,
    owner: typeof site.owner === 'object'
      ? { id: site.owner.id, username: site.owner.username }
      : { id: ownerId },
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  }
  if (privateView) {
    Object.assign(base, {
      claimToken: site.claimToken,
      claimedAt: site.claimedAt || null,
      claimCheckedAt: site.claimCheckedAt || null,
      hasApiKey: Boolean(site.hasApiKey),
      reviewNotes: site.reviewNotes || '',
      reviewedAt: site.reviewedAt || null,
    })
  }
  return base
}

export function relayCheckDto(check: any, privateView = false) {
  const dto: Record<string, unknown> = {
    id: check.id,
    source: check.source,
    protocol: check.protocol,
    model: check.model,
    mode: check.mode,
    status: check.status,
    detectorJobId: check.detectorJobId || null,
    resultUrl: check.resultUrl || null,
    score: typeof check.score === 'number' ? check.score : null,
    grade: check.grade || null,
    verdict: check.verdict || null,
    summary: check.summary || '',
    startedAt: check.startedAt || null,
    finishedAt: check.finishedAt || null,
    durationMs: typeof check.durationMs === 'number' ? check.durationMs : null,
    createdAt: check.createdAt,
  }
  if (privateView) {
    dto.error = check.error || null
    dto.report = check.report || null
  }
  return dto
}
