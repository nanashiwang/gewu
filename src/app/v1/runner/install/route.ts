import { getPayload } from 'payload'
import config from '@payload-config'
import { runnerFromBearer } from '@/lib/runnerAuth'
import { ensureArtifact } from '@/lib/artifacts'
import { resolvePublishedSkill, upsertInstall } from '@/lib/installs'

// POST /v1/runner/install  { slug }  (Bearer) —— 安装 Skill：记录安装事件并返回冻结 manifest
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
  if (!slug) return Response.json({ error: '缺少 slug' }, { status: 400 })

  const resolved = await resolvePublishedSkill(payload, slug)
  if (!resolved) return Response.json({ error: 'Skill 不存在或不可安装' }, { status: 404 })
  const { skill, version } = resolved

  const artifact = await ensureArtifact(payload, skill, version, 'yaml')
  if (!artifact?.manifest) return Response.json({ error: '生成制品失败' }, { status: 500 })

  await upsertInstall(payload, {
    userId: actor.user.id,
    skillId: skill.id,
    versionId: version.id,
    runnerId: actor.runner.id,
    version: version.version,
    checksum: artifact.checksum,
  })

  return Response.json({
    ok: true,
    slug: skill.slug,
    name: skill.title,
    version: version.version,
    checksum: artifact.checksum,
    manifest: artifact.manifest,
  })
}
