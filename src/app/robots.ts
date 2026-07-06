import type { MetadataRoute } from 'next'
import { getPayloadClient } from '@/lib/payload'
import { getServerUrl } from '@/lib/siteUrl'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

export default async function robots(): Promise<MetadataRoute.Robots> {
  let base = getServerUrl()
  try {
    const payload = await getPayloadClient()
    base = getServerUrl(await resolveRuntimeEnv(payload))
  } catch {
    /* DB 不可用时回退 env */
  }
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // 私有/接口路径不索引
      disallow: ['/console', '/admin', '/api/', '/v1/'],
    },
    sitemap: `${base}/sitemap.xml`,
  }
}
