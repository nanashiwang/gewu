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
import { CompatReports } from './collections/CompatReports'
import { CompatTestCases } from './collections/CompatTestCases'
import { AdapterProfiles } from './collections/AdapterProfiles'
import { SkillRuns } from './collections/SkillRuns'
import { FailureCases } from './collections/FailureCases'
import { Reviews } from './collections/Reviews'
import { Favorites } from './collections/Favorites'
import { InviteCodes } from './collections/InviteCodes'
import { ContributionLogs } from './collections/ContributionLogs'
import { ContributionRules } from './collections/ContributionRules'
import { CreditLogs } from './collections/CreditLogs'
import { RechargeCodes } from './collections/RechargeCodes'
import { Notifications } from './collections/Notifications'
import { ModelPriceSnapshots } from './collections/ModelPriceSnapshots'
import { ModelProfiles } from './collections/ModelProfiles'
import { ScoreSnapshots } from './collections/ScoreSnapshots'
import { SkillPassports } from './collections/SkillPassports'
import { RunnerClients } from './collections/RunnerClients'
import { DeviceCodes } from './collections/DeviceCodes'
import { SkillInstalls } from './collections/SkillInstalls'
import { Bounties } from './collections/Bounties'
import { Reports } from './collections/Reports'
import { AuditLogs } from './collections/AuditLogs'
import { EvidenceSnapshots } from './collections/EvidenceSnapshots'
import { Organizations } from './collections/Organizations'
import { OrganizationMembers } from './collections/OrganizationMembers'
import { EnterpriseRegistries } from './collections/EnterpriseRegistries'
import { EnterpriseAuditLogs } from './collections/EnterpriseAuditLogs'
import { Media } from './collections/Media'
import { RelaySites } from './collections/RelaySites'
import { RelayChecks } from './collections/RelayChecks'
import { SiteSettings } from './globals/SiteSettings'
import { EconomySettings } from './globals/EconomySettings'
import { DeploymentSettings } from './globals/DeploymentSettings'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const payloadSecret = (() => {
  const secret = process.env.PAYLOAD_SECRET || ''
  if (secret.length >= 16) return secret
  if (process.env.NODE_ENV === 'production') throw new Error('PAYLOAD_SECRET 必须在生产环境配置为强随机值')
  return 'gewu-dev-secret'
})()

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
    meta: {
      titleSuffix: '· 格物',
    },
  },
  collections: [
    // ── Skill 内容 ──
    Skills,
    SkillVersions,
    SkillPassports,
    SkillArtifacts,
    Categories,
    SkillRuns,
    Bounties,
    CompatReports,
    CompatTestCases,
    AdapterProfiles,
    // ── 中转治理 ──
    RelaySites,
    RelayChecks,
    // ── 成员管理 ──
    Users,
    InviteCodes,
    ContributionLogs,
    ContributionRules,
    CreditLogs,
    RechargeCodes,
    Favorites,
    RunnerClients,
    DeviceCodes,
    SkillInstalls,
    Notifications,
    // ── 审核治理 ──
    Reviews,
    Reports,
    FailureCases,
    EvidenceSnapshots,
    AuditLogs,
    // ── 企业治理 ──
    Organizations,
    OrganizationMembers,
    EnterpriseRegistries,
    EnterpriseAuditLogs,
    // ── 系统设置 ──
    Media,
    ModelProfiles,
    ModelPriceSnapshots,
    ScoreSnapshots,
  ],
  globals: [SiteSettings, EconomySettings, DeploymentSettings],
  editor: lexicalEditor(),
  secret: payloadSecret,
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL,
      // 兜底自愈：事务空闲超 30s 由 PG 自动断开，回收异常残留的 idle-in-transaction 持锁连接
      // （停 dev server / 进程被 kill 时最可靠的持锁缓解，不依赖应用优雅关闭）
      options: '-c idle_in_transaction_session_timeout=30000',
    },
    idType: 'uuid',
  }),
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  cors: [process.env.NEXT_PUBLIC_SERVER_URL || ''].filter(Boolean),
})
