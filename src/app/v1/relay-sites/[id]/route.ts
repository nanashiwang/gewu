import { encryptSecret } from '@/lib/secrets'
import { recordAuditEvent } from '@/lib/audit'
import { readJsonBodyWithLimit } from '@/lib/requestBody'
import { createRelayClaimToken, normalizeRelaySiteInput, relayClaimDomain, relayInputErrorMessage } from '@/lib/relaySite'
import { enforceRelayRateLimit, findRelayForActor, isRelayActorResponse, relayActor, relaySiteDto } from '@/lib/relayApi'

const MAX_BODY = 32 * 1024
const MATERIAL_FIELDS = ['name', 'websiteUrl', 'apiBaseUrl', 'description', 'contacts']

function materialChanged(site: any, input: Record<string, unknown>): boolean {
  return MATERIAL_FIELDS.some((field) => {
    if (!Object.prototype.hasOwnProperty.call(input, field)) return false
    if (field === 'contacts') return JSON.stringify(input.contacts || []) !== JSON.stringify(site.contacts || [])
    return String(input[field] ?? '') !== String(site[field] ?? '')
  })
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  return Response.json({ site: relaySiteDto(found.site, user) })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const limited = await enforceRelayRateLimit(payload, String(user.id), 'update', 30, 60 * 60)
  if (limited) return limited
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  const site = found.site

  const parsed = await readJsonBodyWithLimit(request, MAX_BODY, '中转站资料过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  let input: any
  try {
    input = normalizeRelaySiteInput(parsed.value, { partial: true })
  } catch (error) {
    return Response.json({ error: relayInputErrorMessage(error) }, { status: 400 })
  }
  if (Object.keys(input).length === 0) return Response.json({ error: '无可更新字段' }, { status: 400 })

  const data: Record<string, unknown> = { ...input }
  const apiKeySupplied = Object.prototype.hasOwnProperty.call(input, 'apiKey')
  const nextHasApiKey = apiKeySupplied ? Boolean(input.apiKey) : Boolean(site.hasApiKey)
  const nextScheduleEnabled = Object.prototype.hasOwnProperty.call(input, 'scheduleEnabled')
    ? Boolean(input.scheduleEnabled)
    : Boolean(site.scheduleEnabled)
  if (nextScheduleEnabled && !nextHasApiKey) {
    return Response.json({ error: '启用定时检测前必须配置 API Key' }, { status: 400 })
  }
  if (apiKeySupplied) {
    data.apiKeyEncrypted = input.apiKey ? encryptSecret(input.apiKey) : null
    data.hasApiKey = Boolean(input.apiKey)
    delete data.apiKey
    if (!input.apiKey) data.scheduleEnabled = false
  }
  if (Object.prototype.hasOwnProperty.call(input, 'scheduleIntervalHours')) {
    data.scheduleIntervalHours = String(input.scheduleIntervalHours)
  }

  const nextApiBase = String(input.apiBaseUrl || site.apiBaseUrl)
  const oldDomain = relayClaimDomain(String(site.apiBaseUrl))
  const newDomain = relayClaimDomain(nextApiBase)
  if (newDomain !== oldDomain) {
    data.claimDomain = newDomain
    data.claimToken = createRelayClaimToken()
    data.claimStatus = 'unverified'
    data.claimedAt = null
    data.claimCheckedAt = null
    data.status = 'draft'
    data.nextCheckAt = null
  } else if (site.status === 'approved' && materialChanged(site, input)) {
    data.status = 'pending'
    data.nextCheckAt = null
  }
  if (input.scheduleEnabled === false) data.nextCheckAt = null
  if (input.scheduleEnabled === true && site.status === 'approved' && ['verified', 'manual'].includes(site.claimStatus)) {
    data.nextCheckAt = new Date().toISOString()
  }

  try {
    const updated = await payload.update({ collection: 'relay-sites' as any, id, data, overrideAccess: true, depth: 1 }) as any
    await recordAuditEvent(payload, {
      event: apiKeySupplied ? 'relay_site_updated_with_key_rotation' : 'relay_site_updated',
      actorId: String(user.id),
      targetUserId: String(user.id),
      targetType: 'relay_site',
      targetId: id,
      summary: `更新中转站：${updated.name}`,
      metadata: { fields: Object.keys(input).filter((key) => key !== 'apiKey'), apiKeyChanged: apiKeySupplied },
      request,
    })
    return Response.json({ site: relaySiteDto(updated, user) })
  } catch (error) {
    payload.logger?.error(`更新中转站失败 site=${id}: ${(error as Error).message}`)
    return Response.json({ error: '保存失败，请重试' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  if (!['draft', 'rejected'].includes(String(found.site.status))) {
    return Response.json({ error: '只有草稿或已拒绝的中转站可以删除' }, { status: 409 })
  }
  const checks = await payload.count({ collection: 'relay-checks' as any, where: { site: { equals: id } }, overrideAccess: true })
  if (checks.totalDocs > 0) return Response.json({ error: '已有检测历史的中转站不能删除，可关闭定时检测后保留档案' }, { status: 409 })

  await recordAuditEvent(payload, {
    event: 'relay_site_deleted',
    actorId: String(user.id),
    targetUserId: String(user.id),
    targetType: 'relay_site',
    targetId: id,
    summary: `删除中转站：${found.site.name}`,
    request,
  })
  await payload.delete({ collection: 'relay-sites' as any, id, overrideAccess: true })
  return Response.json({ ok: true })
}
