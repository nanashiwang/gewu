import type { CollectionConfig } from 'payload'
import { isLoggedIn, ownerOrAdmin } from '@/access'
import { awardContribution } from '@/lib/contribution'

async function adjustFavoriteCount(payload: any, skillId: string, delta: number, req?: any) {
  if (!skillId) return
  const tx = req ? { req } : {}
  try {
    const skill = await payload.findByID({
      collection: 'skills',
      id: skillId,
      overrideAccess: true,
      depth: 0,
      ...tx,
    })
    const next = Math.max(0, (skill.favoriteCount || 0) + delta)
    await payload.update({
      collection: 'skills',
      id: skillId,
      data: { favoriteCount: next },
      overrideAccess: true,
      ...tx,
    })
    return skill
  } catch (e) {
    payload.logger?.error(`adjustFavoriteCount 失败: ${(e as Error).message}`)
  }
}

export const Favorites: CollectionConfig = {
  slug: 'favorites',
  labels: { singular: '收藏', plural: '收藏' },
  admin: {
    useAsTitle: 'id',
    defaultColumns: ['user', 'skill', 'createdAt'],
    group: '成员管理',
  },
  access: {
    read: ownerOrAdmin('user'),
    create: isLoggedIn,
    update: ownerOrAdmin('user'),
    delete: ownerOrAdmin('user'),
  },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      label: '用户',
      admin: { readOnly: true },
    },
    { name: 'skill', type: 'relationship', relationTo: 'skills', required: true, label: 'Skill' },
  ],
  hooks: {
    beforeChange: [
      ({ data, req, operation }) => {
        if (operation === 'create' && req.user && !data.user) data.user = req.user.id
        return data
      },
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation !== 'create') return doc
        const skillId = typeof doc.skill === 'object' ? doc.skill?.id : doc.skill
        const skill = await adjustFavoriteCount(req.payload, skillId, +1, req)
        // 给作者 +1 贡献值（非自收藏）
        const authorId = skill && (typeof skill.author === 'object' ? skill.author?.id : skill.author)
        const favUserId = typeof doc.user === 'object' ? doc.user?.id : doc.user
        if (authorId && authorId !== favUserId) {
          await awardContribution(req.payload, {
            userId: authorId,
            actionType: 'skill_favorited',
            points: 1,
            actorId: favUserId,
            relatedSkill: skillId,
            description: 'Skill 被收藏',
            req,
          })
        }
        return doc
      },
    ],
    afterDelete: [
      async ({ doc, req }) => {
        const skillId = typeof doc.skill === 'object' ? doc.skill?.id : doc.skill
        await adjustFavoriteCount(req.payload, skillId, -1, req)
        return doc
      },
    ],
  },
}
