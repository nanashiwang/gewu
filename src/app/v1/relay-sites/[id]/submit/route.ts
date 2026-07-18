import { recordAuditEvent } from '@/lib/audit'
import { findRelayForActor, isRelayActorResponse, relayActor, relaySiteDto } from '@/lib/relayApi'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  const site = found.site
  if (!['verified', 'manual'].includes(String(site.claimStatus))) {
    return Response.json({ error: '提交审核前必须先完成站点所有权验证' }, { status: 409 })
  }
  if (site.scheduleEnabled && !site.hasApiKey) {
    return Response.json({ error: '启用定时检测前必须配置 API Key' }, { status: 409 })
  }
  if (site.status === 'suspended') {
    return Response.json({ error: '该中转站已被暂停，需由管理员复核后恢复' }, { status: 409 })
  }
  if (site.status === 'approved') return Response.json({ site: relaySiteDto(site, user) })
  if (site.status === 'pending') return Response.json({ site: relaySiteDto(site, user) })

  const updated = await payload.update({
    collection: 'relay-sites' as any,
    id,
    overrideAccess: true,
    depth: 1,
    data: { status: 'pending', reviewNotes: null, reviewedAt: null, reviewedBy: null, nextCheckAt: null },
  }) as any
  await recordAuditEvent(payload, {
    event: 'relay_site_submitted',
    actorId: String(user.id),
    targetUserId: String(user.id),
    targetType: 'relay_site',
    targetId: id,
    summary: `提交中转站审核：${site.name}`,
    request,
  })
  return Response.json({ ok: true, site: relaySiteDto(updated, user) })
}
