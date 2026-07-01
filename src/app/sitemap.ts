import type { MetadataRoute } from 'next'
import { getPayloadClient } from '@/lib/payload'

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3000'
  const staticRoutes: MetadataRoute.Sitemap = ['', '/skills', '/rank', '/bounties', '/docs'].map((p) => ({
    url: `${base}${p}`,
    changeFrequency: 'daily',
    priority: p === '' ? 1 : 0.7,
  }))
  let skillRoutes: MetadataRoute.Sitemap = []
  try {
    const payload = await getPayloadClient()
    const res = await payload.find({
      collection: 'skills',
      where: { and: [{ status: { equals: 'published' } }, { visibility: { equals: 'public' } }] },
      limit: 1000,
      depth: 0,
      overrideAccess: true,
    })
    skillRoutes = (res.docs as any[]).map((s) => ({
      url: `${base}/skills/${s.slug}`,
      lastModified: s.lastUpdatedAt || s.updatedAt || undefined,
      changeFrequency: 'weekly',
      priority: 0.6,
    }))
  } catch {
    /* DB 不可用时只返回静态路由 */
  }
  return [...staticRoutes, ...skillRoutes]
}
