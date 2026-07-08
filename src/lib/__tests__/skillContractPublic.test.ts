import { describe, expect, it } from 'vitest'
import { publicSkillContract, selectContractBaseline } from '@/lib/skillContractPublic'

describe('skillContractPublic — 公开 Skill Contract 摘要', () => {
  it('输出 contract hash 和 prompt hash，不暴露 prompt 正文', () => {
    const row = publicSkillContract({
      id: 'v1',
      skill: 'skill-1',
      version: '1.0.0',
      systemPrompt: 'secret system prompt',
      promptTemplate: 'secret user prompt {{input}}',
      inputSchema: { input: { type: 'text' } },
      outputSchema: { result: { type: 'text' } },
      permissions: { network: false },
      contractStatus: 'breaking_change',
      routePolicy: {
        default: 'balanced',
        rawPrompt: 'secret',
        fallback: ['qwen-plus'],
        dataDriven: {
          cheap: ['real-cheap-model'],
          recomputedAt: '2026-07-08T00:00:00.000Z',
        },
      },
      changelog: 'secret prompt detail',
      examples: [{ input: 'a' }, { input: 'b' }],
    }) as any

    expect(row.contractHash).toHaveLength(64)
    expect(row.systemPromptHash).toHaveLength(64)
    expect(row.promptTemplateHash).toHaveLength(64)
    expect(row.examplesCount).toBe(2)
    expect(row.changelogHash).toHaveLength(64)
    expect(row.routePolicy).toEqual({ default: 'balanced', fallback: ['qwen-plus'] })
    expect(row.diff).toMatchObject({ decision: 'baseline', changedFields: [] })
    expect(row.playbook).toMatchObject({
      customerValue: expect.stringContaining('可复核能力契约'),
      decision: 'review_before_upgrade',
      reviewChecklist: expect.arrayContaining([expect.stringContaining('输入 schema')]),
      nextActions: expect.arrayContaining([
        expect.objectContaining({ label: '核对契约 Hash' }),
        expect.objectContaining({ label: '检查破坏性变更' }),
      ]),
    })
    expect(row.routePolicy.dataDriven).toBeUndefined()
    expect(row.systemPrompt).toBeUndefined()
    expect(row.promptTemplate).toBeUndefined()
    expect(row.changelog).toBeUndefined()
    expect(JSON.stringify(row.playbook)).not.toContain('secret')
  })

  it('带 slug 时输出证书验签与试跑入口', () => {
    const row = publicSkillContract({ id: 'v1', version: '1.0.0', contractStatus: 'compatible_change' }, { slug: 'writer' }) as any

    expect(row.playbook.decision).toBe('safe_to_trial')
    expect(row.playbook.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '核对契约 Hash', href: '/v1/skills/writer/contract' }),
        expect.objectContaining({
          label: '验签达标证书',
          href: '/verify?certificateUrl=%2Fv1%2Fskills%2Fwriter%2Fcertificate',
        }),
        expect.objectContaining({ label: '试跑或重跑', href: '/skills/writer/run' }),
      ]),
    )
  })

  it('输出版本契约 diff，敏感 prompt 只给 hash 不给正文', () => {
    const row = publicSkillContract({
      id: 'v2',
      version: '2.0.0',
      systemPrompt: 'new secret system',
      promptTemplate: 'new secret template',
      inputSchema: { topic: { type: 'string' }, tone: { type: 'string' } },
      outputSchema: { result: { type: 'text' } },
      permissions: { network: true, shell: false },
      minRunnerVersion: '0.3.0',
      routePolicy: { default: 'quality', dataDriven: { cheap: ['hidden'] }, rawPrompt: 'secret route prompt' },
    }, {
      previousVersion: {
        id: 'v1',
        version: '1.0.0',
        systemPrompt: 'old secret system',
        promptTemplate: 'old secret template',
        inputSchema: { topic: { type: 'string' } },
        outputSchema: { result: { type: 'text' } },
        permissions: { network: false, shell: false },
        minRunnerVersion: '0.2.0',
        routePolicy: { default: 'balanced' },
      },
    }) as any

    expect(row.diff.decision).toBe('review_before_upgrade')
    expect(row.diff.comparedWith).toMatchObject({ id: 'v1', version: '1.0.0' })
    expect(row.diff.breakingFields).toEqual(expect.arrayContaining(['inputSchema', 'permissions', 'minRunnerVersion']))
    expect(row.diff.compatibleFields).toEqual(expect.arrayContaining(['systemPrompt', 'promptTemplate', 'routePolicy']))
    expect(row.diff.changedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'systemPrompt', beforeHash: expect.any(String), afterHash: expect.any(String) }),
        expect.objectContaining({ field: 'routePolicy', after: { default: 'quality' } }),
      ]),
    )
    const text = JSON.stringify(row.diff)
    expect(text).not.toContain('new secret')
    expect(text).not.toContain('old secret')
    expect(text).not.toContain('hidden')
    expect(text).not.toContain('secret route prompt')
  })

  it('支持选择 Contract diff 对比基线，且列出可用基线', () => {
    const current = { id: 'v3', version: '3.0.0' }
    const versions = [
      current,
      { id: 'v2', version: '2.0.0', status: 'published', inputSchema: { topic: 'string' } },
      { id: 'v1', version: '1.0.0', status: 'published', inputSchema: { title: 'string' } },
      { id: 'old', version: '0.9.0', status: 'deprecated' },
    ]

    expect(selectContractBaseline(versions, current, new URLSearchParams({ compareVersion: '1.0.0' }))).toMatchObject({
      previousVersion: { id: 'v1', version: '1.0.0' },
      baselineSource: 'requested_version',
      availableBaselines: [
        expect.objectContaining({ id: 'v2', version: '2.0.0', contractHash: expect.any(String) }),
        expect.objectContaining({ id: 'v1', version: '1.0.0', contractHash: expect.any(String) }),
      ],
    })
    expect(selectContractBaseline(versions, current, new URLSearchParams({ compareVersionId: 'v2' }))).toMatchObject({
      previousVersion: { id: 'v2' },
      baselineSource: 'requested_id',
    })
    expect(selectContractBaseline(versions, current, new URLSearchParams({ compareVersion: 'none' }))).toMatchObject({
      previousVersion: undefined,
      baselineSource: 'none',
    })
    expect(selectContractBaseline(versions, current, new URLSearchParams({ compareVersion: 'missing' }))).toMatchObject({
      missing: true,
      baselineSource: 'requested_version',
    })
    expect(publicSkillContract(current, {
      previousVersion: versions[1],
      baselineSource: 'requested_id',
    }).diff).toMatchObject({ baselineSource: 'requested_id' })
  })
})
