import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPayloadClient } from '@/lib/payload'
import { getCurrentUser } from '@/lib/auth'
import { RunStudio } from '@/components/RunStudio'
import { approvedPlatformModels } from '@/lib/constants'
import { resolveRuntimeEnv } from '@/lib/deploymentSettings'

export const dynamic = 'force-dynamic'

export default async function RunPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const payload = await getPayloadClient()
  const res = await payload.find({
    collection: 'skills',
    where: { slug: { equals: slug } },
    depth: 2,
    limit: 1,
  })
  const skill = res.docs[0]
  if (!skill || skill.status !== 'published') notFound()

  let version: any = skill.currentVersion
  if (!version || typeof version === 'string') {
    version = (
      await payload.find({
        collection: 'skill-versions',
        where: { skill: { equals: skill.id } },
        sort: '-createdAt',
        limit: 1,
      })
    ).docs[0]
  }

  const user = await getCurrentUser()
  const fullUser = user
    ? await payload.findByID({ collection: 'users', id: user.id, depth: 0, overrideAccess: true }).catch(() => null)
    : null
  const inputSchema = (version?.inputSchema || {}) as Record<string, any>
  const models = ((version?.recommendedModels as any)?.cloud || []) as string[]
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const platformModels = [...approvedPlatformModels(runtimeEnv)]

  return (
    <div className="space-y-4">
      <Link href={`/skills/${slug}`} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
        ← 返回详情
      </Link>
      <div>
        <h1 className="text-xl font-semibold">运行：{skill.title}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{skill.description}</p>
      </div>
      <RunStudio
        slug={skill.slug as string}
        inputSchema={inputSchema}
        loggedIn={!!user}
        models={models}
        platformModels={platformModels}
        hasByok={!!(fullUser as any)?.newapiKeyEncrypted}
      />
    </div>
  )
}
