import type { Payload } from 'payload'
import { buildManifest, manifestToJson, manifestToYaml } from './manifest'

export type ArtifactFormat = 'yaml' | 'json'

async function findArtifact(payload: Payload, versionId: string, format: ArtifactFormat) {
  const res = await payload.find({
    collection: 'skill-artifacts',
    where: { and: [{ skillVersion: { equals: versionId } }, { format: { equals: format } }] },
    limit: 1,
    overrideAccess: true,
  })
  return res.docs[0] as any
}

/**
 * 幂等地确保某版本某格式的冻结制品存在：已存在则直接返回，否则按当前 Skill+版本
 * 规范化生成 manifest、算 checksum、落库（不可变快照）。
 */
export async function ensureArtifact(
  payload: Payload,
  skill: any,
  version: any,
  format: ArtifactFormat,
) {
  const existing = await findArtifact(payload, version.id, format)
  if (existing) return existing

  // 需要 author/category 已 populate 才能生成完整 manifest
  const populated =
    skill && typeof skill.author === 'object' && typeof skill.category === 'object'
      ? skill
      : await payload.findByID({ collection: 'skills', id: skill.id, depth: 2, overrideAccess: true })

  const manifest = buildManifest(populated, version, { siteUrl: process.env.NEXT_PUBLIC_SERVER_URL })
  const body = format === 'json' ? manifestToJson(manifest) : manifestToYaml(manifest)
  const checksum = (manifest as any).integrity?.checksum

  try {
    return (await payload.create({
      collection: 'skill-artifacts',
      overrideAccess: true,
      data: {
        skill: populated.id,
        skillVersion: version.id,
        version: version.version,
        format,
        manifest: body,
        checksum,
        fileSize: Buffer.byteLength(body, 'utf8'),
      },
    })) as any
  } catch {
    // 并发下可能已被另一请求创建，重查返回
    return findArtifact(payload, version.id, format)
  }
}
