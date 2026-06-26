import { getPayload } from 'payload'
import config from '@payload-config'
import { buildManifest, manifestToYaml, manifestToJson } from '@/lib/manifest'

// GET /v1/skills/{slug}/manifest?format=yaml|json —— 下载 Skill 能力包（可移植，本地可运行）
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const format = (new URL(request.url).searchParams.get('format') || 'yaml').toLowerCase()

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

  const manifest = buildManifest(skill, version, {
    siteUrl: process.env.NEXT_PUBLIC_SERVER_URL,
  })

  // 下载计数（不阻塞响应）
  payload
    .update({
      collection: 'skills',
      id: skill.id as string,
      data: { downloadCount: ((skill as any).downloadCount || 0) + 1 },
      overrideAccess: true,
    })
    .catch(() => {})

  const ver = (version as any).version || '1.0.0'
  const isJson = format === 'json'
  const body = isJson ? manifestToJson(manifest) : manifestToYaml(manifest)
  return new Response(body, {
    headers: {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'application/x-yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${skill.slug}-${ver}.${isJson ? 'json' : 'yaml'}"`,
      'Cache-Control': 'no-store',
    },
  })
}
