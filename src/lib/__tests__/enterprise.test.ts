import { describe, expect, it } from 'vitest'
import {
  canAccessEnterpriseSkill,
  canManageOrganization,
  canReadEnterpriseAudit,
  canReadEnterpriseRegistry,
  canUseEnterpriseSkill,
  enterpriseAuditRowsToCsv,
  enterpriseScimListResponse,
  enterpriseScimTokenDigest,
  enterpriseScimUserResource,
  deprovisionEnterpriseScimMember,
  evaluateEnterpriseIdentityPolicy,
  enterprisePolicyFromTemplate,
  evaluateEnterprisePolicy,
  listEnterprisePolicyTemplates,
  listEnterpriseScimMembers,
  mergeEnterprisePolicy,
  normalizeEnterpriseScimUserInput,
  parseEnterpriseScimUserFilter,
  normalizeEnterpriseIdentityPolicy,
  enterpriseAuditRowsToFailureReports,
  enterpriseFailureKnowledgeFromAuditRows,
  findEnterpriseScimMember,
  getEnterpriseRegistryPassport,
  modelAllowedByRegistry,
  provisionEnterpriseScimMember,
  publicEnterpriseIdentityPolicy,
  publicEnterpriseMember,
  publicEnterpriseOrganization,
  publicEnterpriseRegistry,
  recordEnterpriseRunAudit,
  verifyEnterpriseScimToken,
  validateEnterpriseIdentityPolicy,
  suspendOrganizationMember,
  updateEnterpriseIdentityPolicy,
  upsertEnterpriseRegistry,
  upsertOrganizationMember,
} from '@/lib/enterprise'

describe('enterprise — 企业 Registry 授权', () => {
  it('模型白名单为空或缺失时放行；命中列表时放行', () => {
    expect(modelAllowedByRegistry(undefined, 'qwen-plus')).toBe(true)
    expect(modelAllowedByRegistry([], 'qwen-plus')).toBe(true)
    expect(modelAllowedByRegistry(['qwen-plus'], 'qwen-plus')).toBe(true)
    expect(modelAllowedByRegistry({ models: ['qwen-plus'] }, 'deepseek-chat')).toBe(false)
  })

  it('企业身份策略会规范化 SSO/SCIM 与邮箱域白名单', () => {
    expect(normalizeEnterpriseIdentityPolicy({
      require_sso: true,
      domain_allowlist: ['@Example.com', 'example.com', ' Team.io '],
      sso: { enabled: true, provider: 'oidc', issuer: 'https://idp.example.com', client_id: 'client-1', discovery_url: 'https://idp.example.com/.well-known/openid-configuration' },
      scim: { enabled: true, base_url: 'https://api.example.com/scim', token_digest: 'sha256:abc' },
    })).toMatchObject({
      requireSso: true,
      domainAllowlist: ['example.com', 'team.io'],
      sso: { enabled: true, provider: 'oidc', clientId: 'client-1', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration' },
      scim: { enabled: true, baseUrl: 'https://api.example.com/scim' },
    })
  })


  it('企业身份策略会阻断不完整或不安全的 OIDC/SCIM 配置', () => {
    expect(validateEnterpriseIdentityPolicy({
      requireSso: true,
      domainAllowlist: ['bad_domain'],
      sso: { enabled: true, provider: 'oidc', issuer: 'http://idp.example.com' },
      scim: { enabled: true, baseUrl: 'http://api.example.com/scim', tokenDigest: 'plain-token' },
    }).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'DOMAIN_ALLOWLIST_INVALID',
      'OIDC_CLIENT_ID_MISSING',
      'SSO_URL_INVALID',
      'SCIM_BASE_URL_INVALID',
      'SCIM_TOKEN_DIGEST_INVALID',
    ]))

    expect(validateEnterpriseIdentityPolicy({
      requireSso: true,
      domainAllowlist: ['example.com'],
      sso: { enabled: true, provider: 'oidc', issuer: 'https://idp.example.com', clientId: 'client-1' },
      scim: { enabled: true, baseUrl: 'https://api.example.com/scim', tokenDigest: enterpriseScimTokenDigest('secret') },
    }).filter((issue) => issue.level === 'blocker')).toHaveLength(0)
  })

  it('SCIM token 使用 sha256 digest 校验', () => {
    const digest = enterpriseScimTokenDigest('secret-token')
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(verifyEnterpriseScimToken({ scim: { enabled: true, tokenDigest: digest } }, 'Bearer secret-token')).toEqual({ ok: true })
    expect(verifyEnterpriseScimToken({ scim: { enabled: true, tokenDigest: digest } }, 'Bearer bad')).toMatchObject({
      ok: false,
      reason: 'SCIM token 无效',
    })
  })

  it('SCIM 用户 payload 兼容标准 emails/roles 结构', () => {
    expect(normalizeEnterpriseScimUserInput({
      userName: 'fallback@example.com',
      displayName: 'Alice Zhang',
      emails: [{ value: 'secondary@example.com' }, { value: 'alice@example.com', primary: true }],
      roles: [{ value: 'member' }, { value: 'auditor', primary: true }],
      active: false,
    })).toEqual({
      email: 'alice@example.com',
      username: 'Alice Zhang',
      role: 'auditor',
      active: false,
    })
  })

  it('企业身份策略可拦截非白名单邮箱域和非 SSO 登录', () => {
    const policy = { requireSso: true, domainAllowlist: ['example.com'] }
    expect(evaluateEnterpriseIdentityPolicy(policy, { email: 'a@other.com', authMethod: 'sso' })).toMatchObject({
      ok: false,
      reason: '邮箱域 other.com 不在组织允许范围内',
    })
    expect(evaluateEnterpriseIdentityPolicy(policy, { email: 'a@example.com', authMethod: 'password' })).toMatchObject({
      ok: false,
      reason: '组织身份策略要求 SSO 登录',
    })
    expect(evaluateEnterpriseIdentityPolicy(policy, { email: 'a@example.com', authMethod: 'sso' })).toEqual({ ok: true })
    expect(evaluateEnterpriseIdentityPolicy(policy, { email: 'a@example.com', authMethod: 'scim' })).toEqual({ ok: true })
  })

  it('组织管理员可更新身份策略骨架', async () => {
    const calls: any[] = []
    const payload = {
      findByID: async () => ({ id: 'org-1', owner: 'owner-1', status: 'active' }),
      find: async () => ({ totalDocs: 0, docs: [] }),
      update: async (args: any) => {
        calls.push(args)
        return { id: args.id, ...args.data }
      },
    }

    const result = await updateEnterpriseIdentityPolicy(payload as any, {
      actorId: 'owner-1',
      organizationId: 'org-1',
      identityPolicy: {
        require_sso: true,
        domain_allowlist: ['Example.com'],
        sso: { enabled: true, provider: 'oidc', issuer: 'https://idp.example.com', clientId: 'client-1' },
      },
    })

    expect(result).toMatchObject({ ok: true, identityPolicy: { requireSso: true, domainAllowlist: ['example.com'] } })
    expect(calls[0]).toMatchObject({
      collection: 'organizations',
      id: 'org-1',
      data: {
        identityPolicy: { requireSso: true, domainAllowlist: ['example.com'], sso: { enabled: true, provider: 'oidc', issuer: 'https://idp.example.com', clientId: 'client-1' } },
      },
    })
  })

  it('身份策略公开给控制台/API 时隐藏 SCIM tokenDigest，但保存 configured 可沿用旧摘要', async () => {
    const digest = enterpriseScimTokenDigest('scim-token')
    expect(publicEnterpriseIdentityPolicy({
      scim: { enabled: true, baseUrl: 'https://api.example.com/scim', tokenDigest: digest },
    })).toEqual({
      scim: { enabled: true, baseUrl: 'https://api.example.com/scim', tokenDigest: 'configured' },
    })
    expect(publicEnterpriseOrganization({
      id: 'org-1',
      name: 'Acme',
      owner: { id: 'owner-1', email: 'owner@example.com', newapiKeyEncrypted: 'enc:v1:secret' },
      modelAllowlist: { models: ['qwen-plus'], platformRevenue: 99 },
      policy: { requireByok: true, authorization: 'Bearer secret' },
      identityPolicy: { scim: { enabled: true, baseUrl: 'https://api.example.com/scim', tokenDigest: digest } },
    })).toMatchObject({
      id: 'org-1',
      name: 'Acme',
      owner: { id: 'owner-1', email: 'owner@example.com' },
      modelAllowlist: { models: ['qwen-plus'] },
      policy: { requireByok: true },
      identityPolicy: { scim: { tokenDigest: 'configured' } },
    })

    const calls: any[] = []
    const payload = {
      findByID: async () => ({ id: 'org-1', owner: 'owner-1', status: 'active', identityPolicy: { scim: { enabled: true, baseUrl: 'https://old.example.com/scim', tokenDigest: digest } } }),
      find: async () => ({ totalDocs: 0, docs: [] }),
      update: async (args: any) => {
        calls.push(args)
        return { id: args.id, ...args.data }
      },
    }

    const result = await updateEnterpriseIdentityPolicy(payload as any, {
      actorId: 'owner-1',
      organizationId: 'org-1',
      identityPolicy: { scim: { enabled: true, baseUrl: 'https://api.example.com/scim', tokenDigest: 'configured' } },
    })

    expect(calls[0].data.identityPolicy.scim.tokenDigest).toBe(digest)
    expect(result).toMatchObject({
      ok: true,
      identityPolicy: { scim: { enabled: true, baseUrl: 'https://api.example.com/scim', tokenDigest: 'configured' } },
      organization: { identityPolicy: { scim: { tokenDigest: 'configured' } } },
    })
    expect(JSON.stringify(result)).not.toContain(digest)
    expect(JSON.stringify(publicEnterpriseOrganization({
      id: 'org-1',
      owner: { id: 'owner-1', newapiKeyEncrypted: 'enc:v1:secret' },
      modelAllowlist: { platformRevenue: 99 },
      policy: { authorization: 'Bearer secret' },
      identityPolicy: { scim: { tokenDigest: digest } },
      internalNote: 'secret',
    }))).not.toContain('newapiKeyEncrypted')
  })

  it('企业成员公开摘要只保留关系标识和角色状态，不暴露内部对象字段', () => {
    const member = publicEnterpriseMember({
      id: 'member-1',
      organization: { id: 'org-1', name: 'Acme', identityPolicy: { scim: { tokenDigest: 'sha256:secret' } } },
      user: { id: 'user-1', email: 'a@example.com', username: 'Alice', byokKeyEncrypted: 'enc:v1:secret' },
      role: 'auditor',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      internalNote: 'secret',
    }) as any

    expect(member).toEqual({
      id: 'member-1',
      organization: { id: 'org-1', name: 'Acme' },
      user: { id: 'user-1', email: 'a@example.com', username: 'Alice' },
      role: 'auditor',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: undefined,
    })
    expect(JSON.stringify(member)).not.toContain('tokenDigest')
    expect(JSON.stringify(member)).not.toContain('byokKeyEncrypted')
  })

  it('企业 Registry 公开摘要不透出展开关系对象的内部字段', () => {
    const registry = publicEnterpriseRegistry({
      id: 'reg-1',
      name: '财务 Skill 准入',
      organization: { id: 'org-1', name: 'Acme', identityPolicy: { scim: { tokenDigest: 'sha256:secret' } } },
      skill: { id: 'skill-1', slug: 'finance', title: 'Finance', systemPrompt: 'secret prompt' },
      skillVersion: { id: 'ver-1', version: '1.0.0', promptTemplate: 'secret' },
      passport: { id: 'passport-1', evidenceHash: 'hash', rawReports: [{ input: 'secret' }] },
      approvedBy: { id: 'user-1', email: 'owner@example.com', byokKeyEncrypted: 'enc:v1:secret' },
      approvalStatus: 'approved',
      modelAllowlist: { models: ['qwen-plus'], platformRevenue: 99 },
      auditPolicy: { requireByok: true, authorization: 'Bearer secret' },
      riskNotes: '仅财务部门',
    }) as any

    expect(registry).toMatchObject({
      id: 'reg-1',
      organization: { id: 'org-1', name: 'Acme' },
      skill: { id: 'skill-1', slug: 'finance', name: 'Finance' },
      skillVersion: { id: 'ver-1' },
      passport: { id: 'passport-1' },
      approvedBy: { id: 'user-1', email: 'owner@example.com' },
      modelAllowlist: { models: ['qwen-plus'] },
      auditPolicy: { requireByok: true },
      playbook: {
        customerValue: expect.stringContaining('可审计治理链'),
        decision: 'allow',
        governanceChecklist: expect.arrayContaining([
          expect.stringContaining('组织内 Passport'),
          expect.stringContaining('organizationId'),
        ]),
        nextActions: expect.arrayContaining([
          expect.objectContaining({ label: '复核证据', href: '/v1/enterprise/registry/reg-1/passport' }),
          expect.objectContaining({ label: '绑定模型白名单', href: '/console/enterprise' }),
          expect.objectContaining({ label: '执行运行授权', href: '/skills/finance/run?organizationId=org-1' }),
          expect.objectContaining({ label: '留审计并查失败库', href: '/v1/enterprise/failures?organizationId=org-1' }),
          expect.objectContaining({ label: '导出审计', href: '/v1/enterprise/audit/export?organizationId=org-1' }),
        ]),
      },
    })
    expect(JSON.stringify(registry)).not.toContain('tokenDigest')
    expect(JSON.stringify(registry)).not.toContain('systemPrompt')
    expect(JSON.stringify(registry)).not.toContain('byokKeyEncrypted')
    expect(JSON.stringify(registry)).not.toContain('platformRevenue')
    expect(JSON.stringify(registry)).not.toContain('Bearer secret')
  })

  it('企业 Registry playbook 按审批状态给出准入动作', () => {
    expect(publicEnterpriseRegistry({ id: 'pending', approvalStatus: 'pending' })?.playbook.decision).toBe('review')
    expect(publicEnterpriseRegistry({ id: 'approved', approvalStatus: 'approved' })?.playbook.decision).toBe('allow')
    expect(publicEnterpriseRegistry({ id: 'rejected', approvalStatus: 'rejected' })?.playbook.decision).toBe('block')
    expect(publicEnterpriseRegistry({ id: 'revoked', approvalStatus: 'revoked' })?.playbook.decision).toBe('block')
  })

  it('组织成员 + approved registry 才能使用企业 Skill', async () => {
    const payload = {
      findByID: async () => ({ id: 'org-1', owner: 'owner-1', status: 'active' }),
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1' }] }
        if (args.collection === 'enterprise-registries') return { totalDocs: 1, docs: [{ id: 'r1', modelAllowlist: ['qwen-plus'] }] }
        return { totalDocs: 0, docs: [] }
      },
    }

    await expect(canUseEnterpriseSkill(payload as any, {
      userId: 'user-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      modelName: 'qwen-plus',
    })).resolves.toEqual({ ok: true, registryId: 'r1' })
  })

  it('canAccessEnterpriseSkill 只校验成员和 approved registry，不预判模型/策略', async () => {
    const payload = {
      findByID: async () => ({ id: 'org-1', owner: 'owner-1', status: 'active' }),
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1' }] }
        if (args.collection === 'enterprise-registries') {
          return { totalDocs: 1, docs: [{ id: 'r1', modelAllowlist: ['qwen-plus'], auditPolicy: { requireByok: true } }] }
        }
        return { totalDocs: 0, docs: [] }
      },
    }

    await expect(canAccessEnterpriseSkill(payload as any, {
      userId: 'user-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
    })).resolves.toEqual({ ok: true, registryId: 'r1' })
  })

  it('模型不在企业白名单时拒绝', async () => {
    const payload = {
      findByID: async () => ({ id: 'org-1', owner: 'user-1', status: 'active' }),
      find: async () => ({ totalDocs: 1, docs: [{ id: 'r1', modelAllowlist: ['qwen-plus'] }] }),
    }

    await expect(canUseEnterpriseSkill(payload as any, {
      userId: 'user-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      modelName: 'deepseek-chat',
    })).resolves.toMatchObject({ ok: false })
  })

  it('企业审计导出 CSV 会转义逗号和引号', () => {
    const csv = enterpriseAuditRowsToCsv([
      {
        createdAt: '2026-07-08T00:00:00.000Z',
        organization: 'org-1',
        runId: 'run-1',
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
        outcome: 'denied',
        policyReason: '模型 \"x,y\" 不在白名单',
      },
    ])

    expect(csv).toContain('createdAt,organization')
    expect(csv).toContain('run-1,qwen-plus,2026-07-01')
    expect(csv).toContain('\"模型 \"\"x,y\"\" 不在白名单\"')
  })

  it('组织 owner / auditor 可读企业审计', async () => {
    const payload = {
      findByID: async () => ({ id: 'org-1', owner: 'owner-1', status: 'active' }),
      find: async () => ({ totalDocs: 1, docs: [{ id: 'm1', role: 'auditor' }] }),
    }

    await expect(canReadEnterpriseAudit(payload as any, {
      userId: 'owner-1',
      organizationId: 'org-1',
    })).resolves.toEqual({ ok: true })
    await expect(canReadEnterpriseAudit(payload as any, {
      userId: 'auditor-1',
      organizationId: 'org-1',
    })).resolves.toEqual({ ok: true })
  })

  it('recordEnterpriseRunAudit 只写脱敏规模档和治理元数据', async () => {
    const calls: any[] = []
    const payload = {
      create: async (args: any) => {
        calls.push(args)
        return { id: 'audit-1' }
      },
    }

    await recordEnterpriseRunAudit(payload as any, {
      organizationId: 'org-1',
      registryId: 'reg-1',
      actorId: 'user-1',
      skillId: 'skill-1',
      skillVersionId: 'version-1',
      runId: 'run-1',
      modelName: 'qwen-plus',
      modelVersion: '2026-07-01',
      success: true,
      input: { text: 'hello' },
      outputText: 'ok',
      latencyMs: 123,
      estimatedCost: 0.01,
      chargedCredits: 1,
      metadata: { requestId: 'req-1', authorization: 'Bearer abcdefghijklmnop', nested: { apiKey: 'sk-1234567890SECRET' } },
    })

    expect(calls[0]).toMatchObject({
      collection: 'enterprise-audit-logs',
      overrideAccess: true,
      data: {
        organization: 'org-1',
        registry: 'reg-1',
        actor: 'user-1',
        skill: 'skill-1',
        skillVersion: 'version-1',
        runId: 'run-1',
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
        outcome: 'success',
        inputSizeBucket: '0-100',
        outputSizeBucket: '0-100',
        metadata: { requestId: 'req-1', authorization: '<redacted>', nested: { apiKey: '<redacted>' } },
      },
    })
    expect(JSON.stringify(calls[0].data)).not.toContain('hello')
    expect(JSON.stringify(calls[0].data)).not.toContain('sk-1234567890SECRET')
  })

  it('组织 owner / approver 可审批企业 Registry，普通成员不可审批', async () => {
    const calls: any[] = []
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skills') return { id: 'skill-1', title: '会议纪要整理' }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1', role: 'approver' }] }
        if (args.collection === 'enterprise-registries') return { totalDocs: 0, docs: [] }
        return { totalDocs: 0, docs: [] }
      },
      create: async (args: any) => {
        calls.push(args)
        return { id: 'reg-1', ...args.data }
      },
    }

    await expect(canManageOrganization(payload as any, {
      userId: 'approver-1',
      organizationId: 'org-1',
      roles: ['owner', 'admin', 'approver'],
    })).resolves.toEqual({ ok: true, role: 'approver' })

    const result = await upsertEnterpriseRegistry(payload as any, {
      actorId: 'approver-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      approvalStatus: 'approved',
      modelAllowlist: { models: ['qwen-plus'] },
      policyTemplate: 'low_risk',
      auditPolicy: { maxInputChars: 3000 },
    })

    expect(result).toMatchObject({ ok: true, created: true })
    expect(calls[0]).toMatchObject({
      collection: 'enterprise-registries',
      data: {
        organization: 'org-1',
        skill: 'skill-1',
        approvalStatus: 'approved',
        approvedBy: 'approver-1',
        modelAllowlist: { models: ['qwen-plus'] },
        auditPolicy: { maxInputChars: 3000, allowedInputBuckets: ['0-100', '100-500', '500-2k'], allowedRouteModes: ['balanced', 'fast'] },
      },
    })
  })

  it('企业批准前会要求确认未达标证书风险', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skills') return { id: 'skill-1', title: '会议纪要整理' }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1', role: 'approver' }] }
        if (args.collection === 'enterprise-registries') return { totalDocs: 0, docs: [] }
        if (args.collection === 'skill-passports') return { totalDocs: 0, docs: [] }
        return { totalDocs: 0, docs: [] }
      },
      create: async (args: any) => ({ id: 'reg-1', ...args.data }),
    }

    const blocked = await upsertEnterpriseRegistry(payload as any, {
      actorId: 'approver-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      approvalStatus: 'approved',
      enforceCertificateGate: true,
    })
    expect(blocked).toMatchObject({
      ok: false,
      certificateSummary: { status: 'provisional' },
    })

    const accepted = await upsertEnterpriseRegistry(payload as any, {
      actorId: 'approver-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      approvalStatus: 'approved',
      enforceCertificateGate: true,
      certificateRiskAccepted: true,
    })
    expect(accepted).toMatchObject({ ok: true, created: true })
  })

  it('企业批准时显式 passportId 必须属于同一个 Skill', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skills') return { id: 'skill-1', title: '会议纪要整理' }
        if (args.collection === 'skill-passports') return { id: 'passport-other', skill: 'skill-2', status: 'current', skillClass: 'verified', signatureStatus: 'signed', trustScore: 90 }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1', role: 'approver' }] }
        if (args.collection === 'enterprise-registries') return { totalDocs: 0, docs: [] }
        if (args.collection === 'skill-passports') return { totalDocs: 1, docs: [{ id: 'passport-1', skill: 'skill-1', status: 'current', skillClass: 'verified', signatureStatus: 'signed', trustScore: 90 }] }
        return { totalDocs: 0, docs: [] }
      },
    }

    const result = await upsertEnterpriseRegistry(payload as any, {
      actorId: 'approver-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      passportId: 'passport-other',
      approvalStatus: 'approved',
      enforceCertificateGate: true,
    })

    expect(result).toMatchObject({
      ok: false,
      certificateSummary: { status: 'failed', statusReasons: ['passport_skill_mismatch'] },
    })
  })

  it('企业批准证书校验会拒绝跨 Skill 或已废弃的 Contract 版本', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skills') return { id: 'skill-1', title: '会议纪要整理', currentVersion: 'version-1' }
        if (args.collection === 'skill-versions') return { id: 'version-1', skill: 'skill-2', status: 'active' }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1', role: 'approver' }] }
        if (args.collection === 'enterprise-registries') return { totalDocs: 0, docs: [] }
        if (args.collection === 'skill-passports') return { totalDocs: 1, docs: [{ id: 'passport-1', skill: 'skill-1', status: 'current', skillClass: 'verified', signatureStatus: 'signed', trustScore: 90 }] }
        return { totalDocs: 0, docs: [] }
      },
    }

    const result = await upsertEnterpriseRegistry(payload as any, {
      actorId: 'approver-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      approvalStatus: 'approved',
      enforceCertificateGate: true,
    })

    expect(result).toMatchObject({
      ok: false,
      certificateSummary: { status: 'failed', statusReasons: ['contract_version_invalid'] },
    })

    const deprecatedPayload = {
      ...payload,
      findByID: async (args: any) => {
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skills') return { id: 'skill-1', title: '会议纪要整理', currentVersion: 'version-1' }
        if (args.collection === 'skill-versions') return { id: 'version-1', skill: 'skill-1', status: 'deprecated' }
        return null
      },
    }
    await expect(upsertEnterpriseRegistry(deprecatedPayload as any, {
      actorId: 'approver-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      approvalStatus: 'approved',
      enforceCertificateGate: true,
    })).resolves.toMatchObject({
      ok: false,
      certificateSummary: { status: 'failed', statusReasons: ['contract_version_invalid'] },
    })
  })

  it('组织管理员可添加成员；移除成员会置为 suspended 保留审计痕迹', async () => {
    const calls: any[] = []
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'users') return { id: 'user-2' }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members' && args.where?.and?.some((x: any) => x.user?.equals === 'admin-1')) {
          return { totalDocs: 1, docs: [{ id: 'admin-member', role: 'admin', status: 'active' }] }
        }
        if (args.collection === 'organization-members' && args.where?.and?.some((x: any) => x.user?.equals === 'user-2')) {
          return { totalDocs: 0, docs: [] }
        }
        return { totalDocs: 0, docs: [] }
      },
      create: async (args: any) => {
        calls.push(args)
        return { id: 'member-2', ...args.data }
      },
      update: async (args: any) => {
        calls.push(args)
        return { id: args.id, ...args.data }
      },
    }

    const added = await upsertOrganizationMember(payload as any, {
      actorId: 'admin-1',
      organizationId: 'org-1',
      userId: 'user-2',
      role: 'auditor',
    })
    expect(added).toMatchObject({ ok: true, created: true })
    expect(calls[0]).toMatchObject({
      collection: 'organization-members',
      data: { organization: 'org-1', user: 'user-2', role: 'auditor', status: 'active' },
    })

    const suspended = await suspendOrganizationMember(payload as any, {
      actorId: 'admin-1',
      organizationId: 'org-1',
      userId: 'user-2',
    })
    expect(suspended).toMatchObject({ ok: true })
    expect(calls.at(-1)).toMatchObject({
      collection: 'organization-members',
      data: { organization: 'org-1', user: 'user-2', role: 'member', status: 'suspended' },
    })
  })

  it('添加组织成员时会执行组织身份策略', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') {
          return {
            id: 'org-1',
            owner: 'owner-1',
            status: 'active',
            identityPolicy: { requireSso: true, domainAllowlist: ['example.com'] },
          }
        }
        if (args.collection === 'users') return { id: 'user-2', email: 'user@other.com' }
        return null
      },
      find: async () => ({ totalDocs: 0, docs: [] }),
    }

    await expect(upsertOrganizationMember(payload as any, {
      actorId: 'owner-1',
      organizationId: 'org-1',
      userId: 'user-2',
      role: 'member',
      authMethod: 'sso',
    })).resolves.toMatchObject({
      ok: false,
      reason: '邮箱域 other.com 不在组织允许范围内',
    })
  })

  it('SCIM provision 可创建用户并绑定组织成员', async () => {
    const calls: any[] = []
    const tokenDigest = enterpriseScimTokenDigest('scim-token')
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') {
          return {
            id: 'org-1',
            owner: 'owner-1',
            status: 'active',
            identityPolicy: {
              domainAllowlist: ['example.com'],
              requireSso: true,
              scim: { enabled: true, tokenDigest },
            },
          }
        }
        if (args.collection === 'users') return { id: args.id, email: 'new@example.com' }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'users') return { totalDocs: 0, docs: [] }
        if (args.collection === 'organization-members') return { totalDocs: 0, docs: [] }
        return { totalDocs: 0, docs: [] }
      },
      create: async (args: any) => {
        calls.push(args)
        if (args.collection === 'users') return { id: 'user-new', ...args.data }
        if (args.collection === 'organization-members') return { id: 'member-new', ...args.data }
        return { id: 'created', ...args.data }
      },
    }

    const result = await provisionEnterpriseScimMember(payload as any, {
      organizationId: 'org-1',
      bearerToken: 'Bearer scim-token',
      email: 'New@Example.com',
      role: 'member',
    })

    expect(result).toMatchObject({ ok: true, createdUser: true, createdMember: true })
    expect(calls[0]).toMatchObject({
      collection: 'users',
      data: { email: 'new@example.com', role: 'user', accountStatus: 'active' },
    })
    expect(calls[1]).toMatchObject({
      collection: 'organization-members',
      data: { organization: 'org-1', user: 'user-new', role: 'member', status: 'active' },
    })
  })



  it('SCIM filter 支持 userName/email/emails.value eq 查询语法', () => {
    expect(parseEnterpriseScimUserFilter('userName eq "user@example.com"')).toEqual({ email: 'user@example.com' })
    expect(parseEnterpriseScimUserFilter('emails.value eq "user@example.com"')).toEqual({ email: 'user@example.com' })
    expect(parseEnterpriseScimUserFilter('displayName co "user"')).toMatchObject({ unsupported: 'displayName co "user"' })
  })

  it('SCIM 兼容 PATCH Operations、User resource 和 ListResponse', () => {
    const input = normalizeEnterpriseScimUserInput({
      organizationId: 'org-1',
      Operations: [
        { op: 'replace', path: 'userName', value: 'Patch@Example.com' },
        { op: 'replace', path: 'active', value: false },
      ],
    })
    expect(input).toMatchObject({ email: 'Patch@Example.com', active: false })

    const resource = enterpriseScimUserResource(
      { id: 'user-1', email: 'patch@example.com', username: 'Patch User' },
      { role: 'admin', status: 'active' },
    )
    expect(resource).toMatchObject({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: 'user-1',
      userName: 'patch@example.com',
      active: true,
      emails: [{ value: 'patch@example.com', primary: true }],
      roles: [{ value: 'admin', primary: true }],
    })
    expect(enterpriseScimListResponse([resource], 1, 1, 1)).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 1,
      Resources: [resource],
    })
  })

  it('SCIM 可查询并停用组织成员', async () => {
    const calls: any[] = []
    const tokenDigest = enterpriseScimTokenDigest('scim-token')
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') {
          return {
            id: 'org-1',
            owner: 'owner-1',
            status: 'active',
            identityPolicy: { scim: { enabled: true, tokenDigest } },
          }
        }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'users') return { totalDocs: 1, docs: [{ id: 'user-1', email: 'user@example.com' }] }
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'member-1', user: 'user-1', status: 'active' }] }
        return { totalDocs: 0, docs: [] }
      },
      update: async (args: any) => {
        calls.push(args)
        return { id: args.id, ...args.data }
      },
    }

    await expect(findEnterpriseScimMember(payload as any, {
      organizationId: 'org-1',
      bearerToken: 'Bearer scim-token',
      email: 'user@example.com',
    })).resolves.toMatchObject({ ok: true, user: { id: 'user-1' }, member: { id: 'member-1' } })

    await expect(deprovisionEnterpriseScimMember(payload as any, {
      organizationId: 'org-1',
      bearerToken: 'Bearer scim-token',
      email: 'user@example.com',
    })).resolves.toMatchObject({ ok: true, member: { status: 'suspended' } })
    expect(calls[0]).toMatchObject({
      collection: 'organization-members',
      id: 'member-1',
      data: { status: 'suspended' },
    })
  })




  it('SCIM 可列出组织成员为标准 ListResponse 资源', async () => {
    const tokenDigest = enterpriseScimTokenDigest('scim-token')
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'organizations') return { id: 'org-1', status: 'active', identityPolicy: { scim: { enabled: true, tokenDigest } } }
        if (args.collection === 'users') return { id: args.id, email: 'fallback@example.com' }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') {
          return {
            totalDocs: 2,
            docs: [
              { id: 'm1', user: { id: 'user-1', email: 'a@example.com' }, role: 'member', status: 'active' },
              { id: 'm2', user: 'user-2', role: 'auditor', status: 'suspended' },
            ],
          }
        }
        return { totalDocs: 0, docs: [] }
      },
    }

    const result = await listEnterpriseScimMembers(payload as any, {
      organizationId: 'org-1',
      bearerToken: 'Bearer scim-token',
      startIndex: 1,
      count: 2,
    })
    expect(result).toMatchObject({ ok: true, totalResults: 2, itemsPerPage: 2 })
    expect((result as any).resources).toMatchObject([
      { id: 'user-1', userName: 'a@example.com', active: true },
      { id: 'user-2', userName: 'fallback@example.com', active: false, roles: [{ value: 'auditor', primary: true }] },
    ])
  })

  it('企业成员可读取已批准 Registry 的组织内 Passport', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'enterprise-registries') {
          return { id: 'reg-1', organization: 'org-1', skill: 'skill-1', passport: 'passport-1', approvalStatus: 'approved' }
        }
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skill-passports') return { id: 'passport-1', skill: 'skill-1', status: 'current', trustScore: 88 }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1', role: 'member' }] }
        return { totalDocs: 0, docs: [] }
      },
    }

    await expect(canReadEnterpriseRegistry(payload as any, {
      userId: 'user-1',
      registryId: 'reg-1',
    })).resolves.toMatchObject({ ok: true, organizationId: 'org-1', role: 'member' })

    await expect(getEnterpriseRegistryPassport(payload as any, {
      userId: 'user-1',
      registryId: 'reg-1',
    })).resolves.toMatchObject({ ok: true, passport: { id: 'passport-1', trustScore: 88 } })
  })

  it('企业 Registry 显式绑定的 Passport 必须属于同一 Skill，否则回退当前 Passport', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'enterprise-registries') {
          return { id: 'reg-1', organization: 'org-1', skill: 'skill-1', passport: 'passport-other', approvalStatus: 'approved' }
        }
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skill-passports') return { id: 'passport-other', skill: 'skill-2', status: 'current', trustScore: 99 }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1', role: 'member' }] }
        if (args.collection === 'skill-passports') {
          expect(args.where).toEqual({ and: [{ skill: { equals: 'skill-1' } }, { status: { equals: 'current' } }] })
          return { totalDocs: 1, docs: [{ id: 'passport-current', skill: 'skill-1', status: 'current', trustScore: 80 }] }
        }
        return { totalDocs: 0, docs: [] }
      },
    }

    await expect(getEnterpriseRegistryPassport(payload as any, {
      userId: 'user-1',
      registryId: 'reg-1',
    })).resolves.toMatchObject({ ok: true, passport: { id: 'passport-current', trustScore: 80 } })
  })

  it('普通成员读取 Registry Passport 时不会把 draft/stale/revoked 当正式结论', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'enterprise-registries') {
          return { id: 'reg-1', organization: 'org-1', skill: 'skill-1', passport: 'passport-draft', approvalStatus: 'approved' }
        }
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        if (args.collection === 'skill-passports') return { id: 'passport-draft', status: 'draft', trustScore: 88 }
        return null
      },
      find: async (args: any) => {
        if (args.collection === 'organization-members') return { totalDocs: 1, docs: [{ id: 'm1', role: 'member' }] }
        if (args.collection === 'skill-passports') {
          expect(args.where).toEqual({ and: [{ skill: { equals: 'skill-1' } }, { status: { equals: 'current' } }] })
          return { totalDocs: 0, docs: [] }
        }
        return { totalDocs: 0, docs: [] }
      },
    }

    await expect(getEnterpriseRegistryPassport(payload as any, {
      userId: 'user-1',
      registryId: 'reg-1',
    })).resolves.toMatchObject({ ok: true, passport: null })
  })

  it('普通成员不能读取未批准 Registry 的 Passport，审批员可以读取', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'enterprise-registries') return { id: 'reg-1', organization: 'org-1', skill: 'skill-1', approvalStatus: 'pending' }
        if (args.collection === 'organizations') return { id: 'org-1', owner: 'owner-1', status: 'active' }
        return null
      },
      find: async () => ({ totalDocs: 1, docs: [{ id: 'm1', role: 'member' }] }),
    }
    await expect(canReadEnterpriseRegistry(payload as any, {
      userId: 'user-1',
      registryId: 'reg-1',
    })).resolves.toMatchObject({ ok: false })

    const approverPayload = { ...payload, find: async () => ({ totalDocs: 1, docs: [{ id: 'm2', role: 'approver' }] }) }
    await expect(canReadEnterpriseRegistry(approverPayload as any, {
      userId: 'approver-1',
      registryId: 'reg-1',
    })).resolves.toMatchObject({ ok: true, role: 'approver' })
  })




  it('企业策略模板可枚举、合并并由调用方覆盖', () => {
    const templates = listEnterprisePolicyTemplates()
    expect(templates.map((t) => t.key)).toContain('strict_byok')
    expect(enterprisePolicyFromTemplate('low_risk')).toMatchObject({ maxInputChars: 5000 })
    expect(mergeEnterprisePolicy('strict_byok', { maxInputChars: 8000 })).toMatchObject({
      requireByok: true,
      blockedRouteModes: ['cheap'],
      maxInputChars: 8000,
    })
  })

  it('企业策略包可限制输入规模、路由模式和 BYOK', () => {
    expect(evaluateEnterprisePolicy({ maxInputChars: 5 }, { input: { text: 'abcdef' } })).toMatchObject({ ok: false })
    expect(evaluateEnterprisePolicy({ blockedInputBuckets: ['0-100'] }, { input: { text: 'abc' } })).toMatchObject({ ok: false })
    expect(evaluateEnterprisePolicy({ allowedRouteModes: ['quality'] }, { routeMode: 'cheap' })).toMatchObject({ ok: false })
    expect(evaluateEnterprisePolicy({ requireByok: true }, { byok: false })).toMatchObject({ ok: false })
    expect(evaluateEnterprisePolicy({ maxInputChars: 100, allowedRouteModes: ['quality'] }, { input: { text: 'abc' }, routeMode: 'quality' })).toEqual({ ok: true })
  })

  it('canUseEnterpriseSkill 会执行 registry auditPolicy', async () => {
    const payload = {
      findByID: async () => ({ id: 'org-1', owner: 'user-1', status: 'active' }),
      find: async (args: any) => {
        if (args.collection === 'enterprise-registries') {
          return { totalDocs: 1, docs: [{ id: 'r1', modelAllowlist: ['qwen-plus'], auditPolicy: { requireByok: true } }] }
        }
        return { totalDocs: 0, docs: [] }
      },
    }

    await expect(canUseEnterpriseSkill(payload as any, {
      userId: 'user-1',
      organizationId: 'org-1',
      skillId: 'skill-1',
      modelName: 'qwen-plus',
      byok: false,
    })).resolves.toMatchObject({ ok: false, reason: '企业策略要求使用 BYOK 运行' })
  })

  it('企业失败知识库只从脱敏审计元数据聚合，不含输入输出原文', () => {
    const rows = [
      {
        outcome: 'failed',
        errorCode: 'json_invalid',
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
        skill: { id: 'skill-1', title: '标题生成', slug: 'title-maker' },
        inputSizeBucket: '0-100',
        outputSizeBucket: '0-100',
        metadata: { note: 'safe' },
      },
      {
        outcome: 'denied',
        policyReason: '模型不在白名单',
        modelName: 'deepseek-chat',
        skill: { id: 'skill-1', title: '标题生成', slug: 'title-maker' },
        inputSizeBucket: '0-100',
      },
      { outcome: 'success', modelName: 'qwen-plus', input: 'should-not-exist' },
    ]

    expect(enterpriseAuditRowsToFailureReports(rows)).toEqual([
      {
        errorType: 'json_invalid',
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
        skill: { id: 'skill-1', title: '标题生成', slug: 'title-maker' },
        inputSizeBucket: '0-100',
        outputSizeBucket: '0-100',
        source: 'enterprise_run',
      },
      {
        errorType: 'policy_denied',
        modelName: 'deepseek-chat',
        skill: { id: 'skill-1', title: '标题生成', slug: 'title-maker' },
        inputSizeBucket: '0-100',
        outputSizeBucket: undefined,
        source: 'enterprise_policy',
      },
    ])

    const groups = enterpriseFailureKnowledgeFromAuditRows(rows)
    expect(groups).toHaveLength(2)
    expect(JSON.stringify(groups)).not.toContain('should-not-exist')
    expect(groups[0]).toMatchObject({ primaryInputBucket: '0-100', skillCount: 1 })
    expect(groups.find((g) => g.modelName === 'qwen-plus')).toMatchObject({
      primaryModelVersion: '2026-07-01',
      modelVersionBreakdown: { '2026-07-01': 1 },
    })
  })

})
