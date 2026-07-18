import { findRelayForActor, isRelayActorResponse, relayActor, relayCheckDto } from '@/lib/relayApi'
import { boundedIntParam } from '@/lib/queryParams'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await relayActor(request)
  if (isRelayActorResponse(context)) return context
  const { payload, user } = context
  const { id } = await params
  const found = await findRelayForActor(payload, id, user)
  if (found.error) return found.error
  const url = new URL(request.url)
  const page = boundedIntParam(url.searchParams, 'page', 1, 1, 10_000)
  const result = await payload.find({
    collection: 'relay-checks' as any,
    where: { site: { equals: id } },
    sort: '-createdAt',
    page,
    limit: 50,
    depth: 0,
    overrideAccess: true,
  })
  return Response.json({
    docs: (result.docs as any[]).map((check) => relayCheckDto(check, true)),
    page: result.page,
    totalPages: result.totalPages,
    totalDocs: result.totalDocs,
  })
}
