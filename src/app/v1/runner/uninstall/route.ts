import { getPayload } from 'payload'
import config from '@payload-config'
import { runnerFromBearer } from '@/lib/runnerAuth'
import { findInstall, resolvePublishedSkill } from '@/lib/installs'

// POST /v1/runner/uninstall  { slug }  (Bearer) —— 标记安装为已移除
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const actor = await runnerFromBearer(payload, request)
  if (!actor) return Response.json({ error: '未登录或令牌无效' }, { status: 401 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    /* noop */
  }
  const slug = String(body.slug || '').trim()
  const resolved = await resolvePublishedSkill(payload, slug)
  if (!resolved) return Response.json({ ok: true }) // 容忍：本地删了即可

  const install = await findInstall(payload, actor.user.id, resolved.skill.id, actor.runner.id)
  if (install) {
    await payload.update({
      collection: 'skill-installs',
      id: install.id,
      data: { status: 'removed' },
      overrideAccess: true,
    })
  }
  return Response.json({ ok: true })
}
