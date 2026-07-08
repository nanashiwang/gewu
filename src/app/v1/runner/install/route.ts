import { getPayload } from 'payload'
import config from '@payload-config'
import { runnerFromBearer } from '@/lib/runnerAuth'
import { ensureArtifact } from '@/lib/artifacts'
import { resolvePublishedSkill, upsertInstall } from '@/lib/installs'
import { readJsonBodyWithLimit } from '@/lib/requestBody'
import { isRunnerCommandError, MAX_RUNNER_COMMAND_REQUEST_BYTES, normalizeRunnerSlug } from '@/lib/runnerCommandRequest'
import { runnerInstallPlaybook } from '@/lib/runnerInstallPlaybook'

// POST /v1/runner/install  { slug }  (Bearer) —— 安装 Skill：记录安装事件并返回冻结 manifest
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const actor = await runnerFromBearer(payload, request)
  if (!actor) return Response.json({ error: '未登录或令牌无效' }, { status: 401 })

  const parsed = await readJsonBodyWithLimit(request, MAX_RUNNER_COMMAND_REQUEST_BYTES, 'Runner 安装请求体过大', { emptyValue: {} })
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  const slug = normalizeRunnerSlug(parsed.value?.slug)
  if (isRunnerCommandError(slug)) return Response.json({ error: slug.error }, { status: slug.status })

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
    playbook: runnerInstallPlaybook({
      slug: skill.slug,
      version: version.version,
      checksum: artifact.checksum,
      signed: /(^|\n|\{)\s*"?signature"?\s*:/.test(String(artifact.manifest || '')),
    }),
  })
}
