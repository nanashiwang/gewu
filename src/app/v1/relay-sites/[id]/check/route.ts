import { recordAuditEvent } from '@/lib/audit'
import { relayCheckErrorMessage, startRelayCheck } from '@/lib/relayDetection'
import { enforceRelayRateLimit, findRelayForActor, isRelayActorResponse, relayActor, relayCheckDto } from '@/lib/relayApi'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const limited = await enforceRelayRateLimit(payload, String(user.id), 'manual-check', 5, 60 * 60)
  if (limited) return limited
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  const site = found.site
  if (site.status !== 'approved') return Response.json({ error: '只有审核通过的中转站可以从后台发起检测' }, { status: 409 })
  if (!['verified', 'manual'].includes(String(site.claimStatus))) return Response.json({ error: '站点所有权验证已失效' }, { status: 409 })
  if (!site.hasApiKey) return Response.json({ error: '请先配置 API Key' }, { status: 409 })

  try {
    const check = await startRelayCheck(payload, site, { source: 'manual', userId: String(user.id) })
    await recordAuditEvent(payload, {
      event: 'relay_check_started',
      actorId: String(user.id),
      targetUserId: String(user.id),
      targetType: 'relay_site',
      targetId: id,
      summary: `手动检测中转站：${site.name}`,
      metadata: { protocol: site.protocol, model: site.model },
      request,
    })
    return Response.json({ check: relayCheckDto(check, true) }, { status: 202 })
  } catch (error) {
    return Response.json({ error: relayCheckErrorMessage(error) }, { status: 409 })
  }
}
