import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getPayloadClient } from '@/lib/payload'
import { Section, Empty } from '@/components/console/ConsoleUI'
import { EnterprisePolicyPanel } from '@/components/console/EnterprisePolicyPanel'
import { EnterpriseIdentityPanel } from '@/components/console/EnterpriseIdentityPanel'
import { listEnterprisePolicyTemplates, publicEnterpriseOrganization, publicEnterpriseRegistry } from '@/lib/enterprise'

export const dynamic = 'force-dynamic'

export default async function EnterpriseConsolePage() {
  const user = await getCurrentUser()
  const role = (user as any)?.role
  if (!user || !['admin', 'enterprise_admin'].includes(role))
    redirect('/console')

  const payload = await getPayloadClient()
  const orgs = await payload.find({
    collection: 'organizations' as any,
    where: role === 'admin' ? undefined : { owner: { equals: user.id } },
    limit: 20,
    depth: 0,
    overrideAccess: true,
  })
  const orgIds = (orgs.docs as any[]).map((o) => String(o.id))
  const orgRows = (orgs.docs as any[]).map((row) => {
    const o = publicEnterpriseOrganization(row)!
    return {
      id: String(o.id),
      name: o.name || o.slug || 'Organization',
      slug: o.slug,
      identityPolicy: o.identityPolicy,
    }
  })
  const registries = orgIds.length
    ? await payload.find({
        collection: 'enterprise-registries' as any,
        where: { organization: { in: orgIds } },
        limit: 100,
        depth: 1,
        sort: '-updatedAt',
        overrideAccess: true,
      })
    : { docs: [] as any[] }

  const rows = (registries.docs as any[]).map((r) => {
    const safe = publicEnterpriseRegistry(r)!
    return {
      id: safe.id,
      name: safe.name || undefined,
      organization: safe.organization?.id || '',
      skill: safe.skill?.id || '',
      skillTitle: safe.skill?.name || safe.skill?.slug || 'Skill',
      skillSlug: safe.skill?.slug,
      approvalStatus: safe.approvalStatus,
      auditPolicy: safe.auditPolicy,
    }
  })

  return (
    <div className="space-y-5">
      <Section title="企业 Registry 闭环">
        <div className="grid gap-3 text-sm md:grid-cols-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <div className="font-medium text-[var(--text)]">1. 批准 Skill</div>
            <p className="mt-1 text-xs text-[var(--muted)]">
              只把通过 Passport / Contract / 证书复核的 Skill 放入组织注册表。
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <div className="font-medium text-[var(--text)]">2. 绑定策略</div>
            <p className="mt-1 text-xs text-[var(--muted)]">
              限制模型、输入规模、BYOK 和审计边界，让 Skill 适配企业环境。
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <div className="font-medium text-[var(--text)]">3. 留审计</div>
            <p className="mt-1 text-xs text-[var(--muted)]">
              运行、拒绝、失败只记录治理元数据，不暴露员工输入输出原文。
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
            <div className="font-medium text-[var(--text)]">4. 查失败库</div>
            <p className="mt-1 text-xs text-[var(--muted)]">
              从组织审计聚合企业内失败模式，反推 Adapter 和模型治理。
            </p>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs text-[var(--muted)]">
          <b className="text-[var(--text)]">准入判断：</b>
          approved 才进入运行授权；pending/rejected/revoked 只作为复核记录。每条 Registry
          会返回治理 playbook，串起证书复核、模型白名单、审计策略和企业失败库。
        </div>
      </Section>

      <Section title="企业策略包">
        {orgIds.length === 0 ? (
          <Empty>还没有你负责的组织。请先在后台创建 Organization。</Empty>
        ) : (
          <EnterprisePolicyPanel
            registries={rows}
            templates={listEnterprisePolicyTemplates()}
          />
        )}
      </Section>
      <Section title="企业身份策略">
        {orgRows.length === 0 ? (
          <Empty>还没有你负责的组织。</Empty>
        ) : (
          <EnterpriseIdentityPanel organizations={orgRows} />
        )}
      </Section>
      <Section title="说明">
        <div className="space-y-2 text-sm text-[var(--muted)]">
          <p>
            策略包会在企业运行前执行，可限制输入规模、路由模式，或强制 BYOK。
          </p>
          <p>
            身份策略保存组织级白名单、OIDC SSO、SCIM 配置，并在保存时校验 HTTPS
            URL 与 tokenDigest。真实登录连接器后续接入。
          </p>
          <p>
            这里保存的是 Registry 级策略；组织级默认策略仍可在后台
            Organization.policy 配置。
          </p>
        </div>
      </Section>
    </div>
  )
}
