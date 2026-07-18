import { encryptSecret } from '@/lib/secrets'
import { recordAuditEvent } from '@/lib/audit'
import { readJsonBodyWithLimit } from '@/lib/requestBody'
import { createRelayClaimToken, createRelaySlug, normalizeRelaySiteInput, relayClaimDomain, relayInputErrorMessage } from '@/lib/relaySite'
import { enforceRelayRateLimit, isRelayActorResponse, isRelayStaff, relayActor, relaySiteDto } from '@/lib/relayApi'

const MAX_BODY = 32 * 1024

export async function GET(request: Request) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const result = await payload.find({
    collection: 'relay-sites' as any,
    where: isRelayStaff(user) ? {} : { owner: { equals: user.id } },
    sort: '-updatedAt',
    limit: 100,
    depth: 1,
    overrideAccess: true,
  })
  return Response.json({ docs: (result.docs as any[]).map((site) => relaySiteDto(site, user)), totalDocs: result.totalDocs })
}

export async function POST(request: Request) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const limited = await enforceRelayRateLimit(payload, String(user.id), 'create', 10, 60 * 60)
  if (limited) return limited

  const parsed = await readJsonBodyWithLimit(request, MAX_BODY, '中转站资料过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  let input: any
  try {
    input = normalizeRelaySiteInput(parsed.value)
  } catch (error) {
    return Response.json({ error: relayInputErrorMessage(error) }, { status: 400 })
  }
  if (input.scheduleEnabled && !input.apiKey) {
    return Response.json({ error: '启用定时检测前必须填写 API Key' }, { status: 400 })
  }

  const existing = await payload.count({
    collection: 'relay-sites' as any,
    where: { owner: { equals: user.id } },
    overrideAccess: true,
  })
  if (!isRelayStaff(user) && existing.totalDocs >= 20) {
    return Response.json({ error: '每个账号最多管理 20 个中转站' }, { status: 409 })
  }

  const claimDomain = relayClaimDomain(input.apiBaseUrl)
  const data: Record<string, unknown> = {
    ...input,
    owner: user.id,
    slug: createRelaySlug(input.name, input.apiBaseUrl),
    status: 'draft',
    claimStatus: 'unverified',
    claimDomain,
    claimToken: createRelayClaimToken(),
    scheduleIntervalHours: String(input.scheduleIntervalHours || 24),
    apiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : null,
    hasApiKey: Boolean(input.apiKey),
  }
  delete data.apiKey

  try {
    const site = await payload.create({ collection: 'relay-sites' as any, data, overrideAccess: true, depth: 1 }) as any
    await recordAuditEvent(payload, {
      event: 'relay_site_created',
      actorId: String(user.id),
      targetUserId: String(user.id),
      targetType: 'relay_site',
      targetId: String(site.id),
      summary: `创建中转站：${site.name}`,
      metadata: { protocol: site.protocol, claimDomain },
      request,
    })
    return Response.json({ site: relaySiteDto(site, user) }, { status: 201 })
  } catch (error) {
    payload.logger?.error(`创建中转站失败 user=${user.id}: ${(error as Error).message}`)
    return Response.json({ error: '创建失败，请检查资料后重试' }, { status: 500 })
  }
}
