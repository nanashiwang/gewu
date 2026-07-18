import { timingSafeEqual } from 'node:crypto'
import { getPayload } from 'payload'
import config from '@payload-config'
import { runRelayCheckCycle } from '@/lib/relayDetection'

function authorized(request: Request): boolean {
  const expected = String(process.env.RELAY_CRON_SECRET || '')
  if (expected.length < 24) return false
  const header = request.headers.get('authorization') || ''
  const actual = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: '未授权' }, { status: 401 })
  const payload = await getPayload({ config })
  try {
    const result = await runRelayCheckCycle(payload)
    return Response.json({ ok: true, ...result })
  } catch (error) {
    payload.logger?.error(`中转检测定时任务失败: ${(error as Error).message}`)
    return Response.json({ error: '定时任务执行失败' }, { status: 500 })
  }
}
