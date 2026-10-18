import { NextResponse } from 'next/server'
import { findRelayForActor, isRelayActorResponse, relayActor } from '@/lib/relayApi'
import { openRelayReport } from '@/lib/relayDetection'

export async function GET(request: Request, { params }: { params: Promise<{ id: string; checkId: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { id, checkId } = await params
  const found = await findRelayForActor(context.payload, id, context.user)
  if (found.error) return found.error
  try {
    const grant = await openRelayReport(context.payload, id, checkId)
    const response = new NextResponse(null, {
      status: 303, headers: { Location: `/r/${grant.jobId}`, 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' },
    })
    if (grant.owner) {
      const secure = process.env.NODE_ENV === 'production' || new URL(request.url).protocol === 'https:'
      response.cookies.set(`${secure ? '__Host-' : ''}gewu_report_${grant.jobId}`, grant.owner, {
        httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 3600,
      })
    }
    return response
  } catch {
    return Response.json({ error: '报告暂时无法打开，请稍后重试' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
