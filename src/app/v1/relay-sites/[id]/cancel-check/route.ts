import { recordAuditEvent } from '@/lib/audit'
import { cancelRelayCheck } from '@/lib/relayDetection'
import { readJsonBodyWithLimit } from '@/lib/requestBody'
import { enforceRelayRateLimit, findRelayForActor, isRelayActorResponse, relayActor, relayCheckDto } from '@/lib/relayApi'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const limited = await enforceRelayRateLimit(payload, String(user.id), 'cancel-check', 20, 60)
  if (limited) return limited
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  const parsed = await readJsonBodyWithLimit(request, 1024, '取消请求体过大')
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const body = parsed.value
  if (typeof body?.checkId !== 'string' || !body.checkId || body.checkId.length > 80) return Response.json({ error: '检测任务 ID 无效' }, { status: 400 })
  try {
    const check = await cancelRelayCheck(payload, id, body.checkId)
    await recordAuditEvent(payload, {
      event: 'relay_check_cancelled', actorId: String(user.id), targetUserId: String(user.id),
      targetType: 'relay_site', targetId: id, summary: `取消中转站检测：${found.site.name}`,
      metadata: { checkId: body.checkId, status: check.status }, request,
    })
    return Response.json({ check: relayCheckDto(check, true) })
  } catch {
    return Response.json({ error: '未能确认取消结果，请刷新进度后重试；任务正在提交时需要稍候。' }, { status: 409 })
  }
}
