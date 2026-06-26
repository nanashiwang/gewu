import path from 'path'
import { fileURLToPath } from 'url'
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import sharp from 'sharp'

import { Users } from './collections/Users'
import { Categories } from './collections/Categories'
import { Skills } from './collections/Skills'
import { SkillVersions } from './collections/SkillVersions'
import { SkillArtifacts } from './collections/SkillArtifacts'
import { SkillRuns } from './collections/SkillRuns'
import { Reviews } from './collections/Reviews'
import { Favorites } from './collections/Favorites'
import { InviteCodes } from './collections/InviteCodes'
import { ContributionLogs } from './collections/ContributionLogs'
import { Bounties } from './collections/Bounties'
import { Reports } from './collections/Reports'
import { Media } from './collections/Media'
import { SiteSettings } from './globals/SiteSettings'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
    meta: {
      titleSuffix: '· 衡术 Hengshu',
    },
  },
  collections: [
    // ── Skill 内容 ──
    Skills,
    SkillVersions,
    SkillArtifacts,
    Categories,
    SkillRuns,
    Bounties,
    // ── 成员管理 ──
    Users,
    InviteCodes,
    ContributionLogs,
    Favorites,
    // ── 审核治理 ──
    Reviews,
    Reports,
    // ── 系统设置 ──
    Media,
  ],
  globals: [SiteSettings],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  db: postgresAdapter({
    pool: { connectionString: process.env.DATABASE_URL },
    idType: 'uuid',
  }),
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  cors: [process.env.NEXT_PUBLIC_SERVER_URL || ''].filter(Boolean),
})
