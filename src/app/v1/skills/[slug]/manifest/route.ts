import { getPayload } from 'payload'
import config from '@payload-config'
import { ensureArtifact, type ArtifactFormat } from '@/lib/artifacts'

// GET /v1/skills/{slug}/manifest?format=yaml|json
// 下载发「发布时冻结的存量字节」（不可变快照），而非即时生成。
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const format: ArtifactFormat =
    (new URL(request.url).searchParams.get('format') || 'yaml').toLowerCase() === 'json'
      ? 'json'
      : 'yaml'

  const skills = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    depth: 2,
    limit: 1,
    overrideAccess: true,
  })
  const skill = skills.docs[0]
  if (!skill || skill.status !== 'published' || skill.visibility !== 'public') {
    return Response.json({ error: 'Skill 不存在或不可下载' }, { status: 404 })
  }

  let version: any = skill.currentVersion
  if (!version || typeof version === 'string') {
    version = (
      await payload.find({
        collection: 'skill-versions',
        where: { skill: { equals: skill.id } },
        sort: '-createdAt',
        limit: 1,
        overrideAccess: true,
      })
    ).docs[0]
  }
  if (!version) return Response.json({ error: '无可用版本' }, { status: 400 })

  const artifact = await ensureArtifact(payload, skill, version, format)
  if (!artifact?.manifest) {
    return Response.json({ error: '生成制品失败' }, { status: 500 })
  }

  // 下载计数（弱信号，不阻塞）：artifact 粒度 + skill 聚合
  payload
    .update({
      collection: 'skill-artifacts',
      id: artifact.id,
      data: { downloadCount: (artifact.downloadCount || 0) + 1 },
      overrideAccess: true,
    })
    .catch(() => {})
  payload
    .update({
      collection: 'skills',
      id: skill.id as string,
      data: { downloadCount: ((skill as any).downloadCount || 0) + 1 },
      overrideAccess: true,
    })
    .catch(() => {})

  const ver = artifact.version || '1.0.0'
  return new Response(artifact.manifest, {
    headers: {
      'Content-Type':
        format === 'json'
          ? 'application/json; charset=utf-8'
          : 'application/x-yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${skill.slug}-${ver}.${format}"`,
      'X-Hengshu-Checksum': artifact.checksum || '',
      'Cache-Control': 'no-store',
    },
  })
}
