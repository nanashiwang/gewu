import { resolveTxt } from 'node:dns/promises'
import { recordAuditEvent } from '@/lib/audit'
import { enforceRelayRateLimit, findRelayForActor, isRelayActorResponse, relayActor, relaySiteDto } from '@/lib/relayApi'
import { relayClaimRecord } from '@/lib/relaySite'

async function resolveTxtWithTimeout(name: string): Promise<string[][]> {
  return Promise.race([
    resolveTxt(name),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS 查询超时')), 8000)),
  ])
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const limited = await enforceRelayRateLimit(payload, String(user.id), 'verify', 10, 10 * 60)
  if (limited) return limited
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  const site = found.site
  const expected = relayClaimRecord(String(site.claimDomain), String(site.claimToken))
  const checkedAt = new Date().toISOString()

  try {
    const records = await resolveTxtWithTimeout(expected.name)
    const values = records.map((chunks) => chunks.join(''))
    const verified = values.some((value) => value.trim() === expected.value)
    const updated = await payload.update({
      collection: 'relay-sites' as any,
      id,
      overrideAccess: true,
      depth: 1,
      data: {
        claimStatus: verified ? 'verified' : 'failed',
        claimCheckedAt: checkedAt,
        claimedAt: verified ? checkedAt : null,
      },
    }) as any
    await recordAuditEvent(payload, {
      event: verified ? 'relay_claim_verified' : 'relay_claim_failed',
      actorId: String(user.id),
      targetUserId: String(user.id),
      targetType: 'relay_site',
      targetId: id,
      summary: `${verified ? '通过' : '未通过'}中转站 DNS 所有权验证`,
      metadata: { domain: site.claimDomain, recordName: expected.name },
      request,
    })
    if (!verified) return Response.json({ error: '尚未找到正确的 DNS TXT 记录', expected, site: relaySiteDto(updated, user) }, { status: 422 })
    return Response.json({ ok: true, site: relaySiteDto(updated, user) })
  } catch {
    await payload.update({
      collection: 'relay-sites' as any,
      id,
      overrideAccess: true,
      data: { claimStatus: 'failed', claimCheckedAt: checkedAt },
    }).catch(() => undefined)
    return Response.json({ error: 'DNS 查询失败或记录尚未生效，请稍后重试', expected }, { status: 422 })
  }
}
