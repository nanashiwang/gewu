import { recordAuditEvent } from '@/lib/audit'
import { readJsonBodyWithLimit } from '@/lib/requestBody'
import { isRelayActorResponse, isRelayStaff, relayActor, relaySiteDto } from '@/lib/relayApi'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  if (!isRelayStaff(user)) return Response.json({ error: '只有审核员或管理员可以审核中转站' }, { status: 403 })
  const { id } = await params
  const site = await payload.findByID({ collection: 'relay-sites' as any, id, depth: 1, overrideAccess: true }).catch(() => null) as any
  if (!site) return Response.json({ error: '中转站不存在' }, { status: 404 })
  const parsed = await readJsonBodyWithLimit(request, 8 * 1024, '审核请求体过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const action = String(parsed.value?.action || '')
  const notes = String(parsed.value?.notes || '').trim().slice(0, 2000)
  if (!['approve', 'reject', 'suspend'].includes(action)) return Response.json({ error: '审核动作无效' }, { status: 400 })
  if (action === 'approve' && !['verified', 'manual'].includes(String(site.claimStatus))) {
    return Response.json({ error: '站点尚未完成所有权验证，不能通过审核' }, { status: 409 })
  }
  if (action !== 'approve' && notes.length < 2) return Response.json({ error: '拒绝或暂停时必须填写原因' }, { status: 400 })

  const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'suspended'
  const updated = await payload.update({
    collection: 'relay-sites' as any,
    id,
    overrideAccess: true,
    depth: 1,
    data: {
      status,
      reviewNotes: notes || null,
      reviewedBy: user.id,
      reviewedAt: new Date().toISOString(),
      nextCheckAt: action === 'approve' && site.scheduleEnabled && site.hasApiKey ? new Date().toISOString() : null,
    },
  }) as any
  await recordAuditEvent(payload, {
    event: `relay_site_${status}`,
    actorId: String(user.id),
    targetUserId: typeof site.owner === 'object' ? String(site.owner.id) : String(site.owner),
    targetType: 'relay_site',
    targetId: id,
    summary: `${action === 'approve' ? '通过' : action === 'reject' ? '拒绝' : '暂停'}中转站：${site.name}`,
    metadata: { notes },
    request,
  })
  return Response.json({ ok: true, site: relaySiteDto(updated, user) })
}
