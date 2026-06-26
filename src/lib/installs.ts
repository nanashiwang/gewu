import type { Payload } from 'payload'

// 解析一个已发布公开 Skill 及其当前版本
export async function resolvePublishedSkill(payload: Payload, slug: string) {
  const skills = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    depth: 2,
    limit: 1,
    overrideAccess: true,
  })
  const skill = skills.docs[0] as any
  if (!skill || skill.status !== 'published' || skill.visibility !== 'public') return null

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
  if (!version) return null
  return { skill, version }
}

// 幂等 upsert 安装记录（唯一 user + skill + runner）
export async function upsertInstall(
  payload: Payload,
  args: {
    userId: string
    skillId: string
    versionId?: string
    runnerId?: string
    version?: string
    checksum?: string
  },
) {
  const { userId, skillId, versionId, runnerId, version, checksum } = args
  const now = new Date().toISOString()
  const where: any = {
    and: [{ user: { equals: userId } }, { skill: { equals: skillId } }],
  }
  if (runnerId) where.and.push({ runner: { equals: runnerId } })

  const existing = await payload.find({
    collection: 'skill-installs',
    where,
    limit: 1,
    overrideAccess: true,
  })

  const data: any = {
    user: userId,
    skill: skillId,
    skillVersion: versionId,
    runner: runnerId,
    installedVersion: version,
    installedChecksum: checksum,
    status: 'installed',
    lastUsedAt: now,
  }

  if (existing.docs[0]) {
    return payload.update({
      collection: 'skill-installs',
      id: existing.docs[0].id,
      data,
      overrideAccess: true,
    })
  }
  return payload.create({
    collection: 'skill-installs',
    overrideAccess: true,
    data: { ...data, installedAt: now },
  })
}

export async function findInstall(
  payload: Payload,
  userId: string,
  skillId: string,
  runnerId?: string,
) {
  const where: any = { and: [{ user: { equals: userId } }, { skill: { equals: skillId } }] }
  if (runnerId) where.and.push({ runner: { equals: runnerId } })
  const res = await payload.find({ collection: 'skill-installs', where, limit: 1, overrideAccess: true })
  return res.docs[0] as any
}
