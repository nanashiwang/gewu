import { getPayload } from 'payload'
import config from '@payload-config'
import { runnerFromBearer } from '@/lib/runnerAuth'
import { ensureArtifact } from '@/lib/artifacts'
import { resolvePublishedSkill } from '@/lib/installs'

// POST /v1/runner/check  { items: [{slug, checksum}] }  (Bearer)
// 比对各 Skill 当前 checksum，返回是否有更新（不计下载数）
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
  const items: Array<{ slug: string; checksum?: string }> = Array.isArray(body.items) ? body.items : []

  const updates = []
  for (const it of items.slice(0, 100)) {
    const resolved = await resolvePublishedSkill(payload, it.slug)
    if (!resolved) {
      updates.push({ slug: it.slug, available: false })
      continue
    }
    const artifact = await ensureArtifact(payload, resolved.skill, resolved.version, 'yaml')
    updates.push({
      slug: it.slug,
      available: true,
      version: resolved.version.version,
      checksum: artifact?.checksum,
      outdated: !!artifact?.checksum && it.checksum !== artifact.checksum,
    })
  }

  return Response.json({ updates })
}
