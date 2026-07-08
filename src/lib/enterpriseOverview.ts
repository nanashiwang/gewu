import type { Payload } from 'payload'
import {
  canManageOrganization,
  enterpriseIdentityPlaybook,
  getEnterpriseFailureKnowledge,
  listEnterpriseRegistriesForReapproval,
  publicEnterpriseOrganization,
} from './enterprise'

const REGISTRY_STATUSES = ['pending', 'approved', 'restricted', 'disabled', 'deprecated'] as const
const MEMBER_ROLES = ['member', 'approver', 'auditor', 'admin'] as const
const MEMBER_STATUSES = ['active', 'suspended'] as const
const AUDIT_OUTCOMES = ['success', 'failed', 'denied'] as const

function countBy<T extends string>(values: readonly T[]) {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>
}

function relationId(value: unknown): string | undefined {
  if (!value) return undefined
  return typeof value === 'object' ? String((value as any).id || '') || undefined : String(value)
}

function topEntries(counts: Map<string, number>, limit: number) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

function fallbackReapprovalSummary(registries: any[]) {
  const missingBaseline = registries.filter((registry) =>
    ['approved', 'restricted'].includes(String(registry?.approvalStatus || '')) && !registry?.adoptionBaseline,
  ).length
  const recorded = registries.reduce(
    (acc, registry) => {
      const status = String(registry?.auditPolicy?.adoptionReview?.status || '')
      if (status === 'reapproval_required') acc.reapproval_required += 1
      if (status === 'review_recommended') acc.review_recommended += 1
      return acc
    },
    { reapproval_required: 0, review_recommended: 0 },
  )
  return {
    scanned: registries.length,
    returned: missingBaseline + recorded.reapproval_required + recorded.review_recommended,
    actionable: missingBaseline + recorded.reapproval_required + recorded.review_recommended,
    missing_baseline: missingBaseline,
    reapproval_required: recorded.reapproval_required,
    review_recommended: recorded.review_recommended,
    unchanged: Math.max(0, registries.length - missingBaseline - recorded.reapproval_required - recorded.review_recommended),
    source: 'registry_snapshot',
  }
}

function identitySummary(org: any) {
  const playbook = enterpriseIdentityPlaybook(org?.identityPolicy)
  return {
    decision: playbook.decision,
    readiness: playbook.readiness,
    issues: playbook.issues,
    safePolicy: publicEnterpriseOrganization(org)?.identityPolicy || null,
  }
}

export async function getEnterpriseGovernanceOverview(
  payload: Payload,
  args: {
    actorId: string
    actorRole?: string
    organizationId: string
    auditLimit?: number
    failureLimit?: number
  },
): Promise<{ ok: true; overview: any } | { ok: false; reason: string }> {
  const access = await canManageOrganization(payload, {
    userId: args.actorId,
    userRole: args.actorRole,
    organizationId: args.organizationId,
    roles: ['platform_admin', 'owner', 'admin', 'approver'],
  })
  if (!access.ok) return access

  const org = await payload
    .findByID({ collection: 'organizations' as any, id: args.organizationId, depth: 0, overrideAccess: true })
    .catch(() => null) as any
  if (!org) return { ok: false, reason: '组织不存在' }

  const [registriesRes, membersRes, auditsRes, failureGroups] = await Promise.all([
    payload.find({
      collection: 'enterprise-registries' as any,
      where: { organization: { equals: args.organizationId } },
      limit: 500,
      depth: 1,
      sort: '-updatedAt',
      overrideAccess: true,
    }),
    payload.find({
      collection: 'organization-members' as any,
      where: { organization: { equals: args.organizationId } },
      limit: 500,
      depth: 0,
      sort: '-updatedAt',
      overrideAccess: true,
    }),
    payload.find({
      collection: 'enterprise-audit-logs' as any,
      where: { organization: { equals: args.organizationId } },
      limit: Math.min(Math.max(args.auditLimit || 200, 1), 1000),
      depth: 1,
      sort: '-createdAt',
      overrideAccess: true,
    }),
    getEnterpriseFailureKnowledge(payload, {
      organizationId: args.organizationId,
      limit: Math.min(Math.max(args.failureLimit || 1000, 1), 5000),
    }).catch(() => []),
  ])

  const registries = registriesRes.docs as any[]
  const members = membersRes.docs as any[]
  const audits = auditsRes.docs as any[]
  const registryByStatus = countBy(REGISTRY_STATUSES)
  for (const registry of registries) {
    const status = String(registry?.approvalStatus || 'pending') as keyof typeof registryByStatus
    if (status in registryByStatus) registryByStatus[status] += 1
  }

  const memberByRole = countBy(MEMBER_ROLES)
  const memberByStatus = countBy(MEMBER_STATUSES)
  for (const member of members) {
    const role = String(member?.role || 'member') as keyof typeof memberByRole
    const status = String(member?.status || 'active') as keyof typeof memberByStatus
    if (role in memberByRole) memberByRole[role] += 1
    if (status in memberByStatus) memberByStatus[status] += 1
  }

  const auditByOutcome = countBy(AUDIT_OUTCOMES)
  const modelCounts = new Map<string, number>()
  const skillCounts = new Map<string, number>()
  let latestAuditAt: string | null = null
  let estimatedCost = 0
  let chargedCredits = 0
  for (const row of audits) {
    const outcome = String(row?.outcome || '') as keyof typeof auditByOutcome
    if (outcome in auditByOutcome) auditByOutcome[outcome] += 1
    if (!latestAuditAt && row?.createdAt) latestAuditAt = row.createdAt
    const modelKey = [row?.modelName, row?.modelVersion].filter(Boolean).join('@') || 'unknown'
    modelCounts.set(modelKey, (modelCounts.get(modelKey) || 0) + 1)
    const skill = row?.skill && typeof row.skill === 'object'
      ? row.skill.title || row.skill.slug || row.skill.id
      : relationId(row?.skill)
    if (skill) skillCounts.set(String(skill), (skillCounts.get(String(skill)) || 0) + 1)
    const cost = Number(row?.estimatedCost || 0)
    const credits = Number(row?.chargedCredits || 0)
    if (Number.isFinite(cost)) estimatedCost += cost
    if (Number.isFinite(credits)) chargedCredits += credits
  }

  let reapprovalSummary = fallbackReapprovalSummary(registries)
  try {
    const review = await listEnterpriseRegistriesForReapproval(payload, {
      actorId: args.actorId,
      actorRole: args.actorRole,
      organizationId: args.organizationId,
      status: 'all',
      includeUnchanged: true,
      limit: 200,
    })
    if (review.ok) reapprovalSummary = { ...review.summary, source: 'live_reapproval_check' }
  } catch {
    // 保底展示基于 Registry 快照的待办，精准漂移仍可进入批量重审 API 复核。
  }

  const actionable =
    Number(reapprovalSummary.actionable || 0) +
    Number(identitySummary(org).readiness?.blockers || 0) +
    auditByOutcome.failed +
    auditByOutcome.denied
  const decision = actionable > 0 ? 'needs_attention' : 'healthy'

  return {
    ok: true,
    overview: {
      organization: {
        id: String(org.id || args.organizationId),
        name: org.name || org.slug || 'Organization',
        slug: org.slug || null,
        plan: org.plan || 'team',
        status: org.status || 'active',
      },
      decision,
      customerValue:
        '企业治理总览把准入、重审、身份、审计和失败库放到一页，管理员能先处理风险项，再进入策略包或私有评测。',
      registry: {
        total: registriesRes.totalDocs ?? registries.length,
        byStatus: registryByStatus,
        recent: registries.slice(0, 5).map((registry) => ({
          id: String(registry.id || ''),
          name: registry.name || null,
          approvalStatus: registry.approvalStatus || 'pending',
          skill: registry.skill && typeof registry.skill === 'object'
            ? { id: String(registry.skill.id || ''), title: registry.skill.title || registry.skill.slug || null, slug: registry.skill.slug || null }
            : { id: relationId(registry.skill) || '' },
          updatedAt: registry.updatedAt || null,
        })),
      },
      reapproval: reapprovalSummary,
      identity: identitySummary(org),
      members: {
        total: membersRes.totalDocs ?? members.length,
        byRole: memberByRole,
        byStatus: memberByStatus,
      },
      audit: {
        sampled: audits.length,
        total: auditsRes.totalDocs ?? audits.length,
        byOutcome: auditByOutcome,
        latestAuditAt,
        topModels: topEntries(modelCounts, 5),
        topSkills: topEntries(skillCounts, 5),
        estimatedCost: Math.round(estimatedCost * 1_000_000) / 1_000_000,
        chargedCredits: Math.round(chargedCredits * 100) / 100,
      },
      failures: {
        totalGroups: failureGroups.length,
        topGroups: failureGroups.slice(0, 5).map((group) => ({
          profileKey: group.profileKey,
          errorType: group.errorType,
          modelName: group.modelName,
          primaryModelVersion: group.primaryModelVersion,
          primaryInputBucket: group.primaryInputBucket,
          count: group.count,
          skillCount: group.skillCount,
          label: group.meta?.label,
          publicFixHint: group.meta?.publicFixHint,
        })),
      },
      links: {
        reviewRequiredUrl: `/v1/enterprise/registry/review-required?organizationId=${encodeURIComponent(args.organizationId)}`,
        failuresUrl: `/v1/enterprise/failures?organizationId=${encodeURIComponent(args.organizationId)}`,
        auditExportUrl: `/v1/enterprise/audit/export?organizationId=${encodeURIComponent(args.organizationId)}`,
        identityAuthorizeUrl: `/v1/enterprise/identity/authorize?organizationId=${encodeURIComponent(args.organizationId)}`,
        registryApiUrl: '/v1/enterprise/registry',
      },
      nextActions: [
        {
          label: '先处理准入重审',
          href: `/v1/enterprise/registry/review-required?organizationId=${encodeURIComponent(args.organizationId)}`,
          description: reapprovalSummary.actionable
            ? `当前有 ${reapprovalSummary.actionable} 个准入待办，优先刷新基线、重新审批或接受风险。`
            : '当前没有准入重审待办，可继续按既有策略运行。',
        },
        {
          label: '检查身份策略',
          href: '/console/enterprise',
          description: identitySummary(org).readiness?.blockers
            ? '身份策略存在 blocker，启用 SSO/SCIM 前需要先修复。'
            : '身份策略格式通过，可继续补 SSO/SCIM 联调。',
        },
        {
          label: '看失败知识库',
          href: `/v1/enterprise/failures?organizationId=${encodeURIComponent(args.organizationId)}`,
          description: failureGroups.length
            ? '已有企业失败模式，可决定是否锁模型、补 Adapter 或调整策略。'
            : '暂无企业失败模式，后续运行或策略拒绝会进入聚合。',
        },
        {
          label: '导出审计',
          href: `/v1/enterprise/audit/export?organizationId=${encodeURIComponent(args.organizationId)}`,
          description: '导出治理元数据、模型版本和费用，不包含员工输入输出原文。',
        },
      ],
    },
  }
}
