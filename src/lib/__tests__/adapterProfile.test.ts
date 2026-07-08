import { describe, expect, it } from 'vitest'
import { AdapterProfiles } from '@/collections/AdapterProfiles'
import { adapterDraftSummary, applyAdapterToVersion, buildAdapterDraftFromFailureCase, buildAdapterEvidenceHash, computeAdapterLift, createAdapterDraftFromFailureCase, findActiveAdapter, refreshAdapterLift } from '@/lib/adapterProfile'

describe('adapterProfile — 适配补丁', () => {
  it('把 prompt/schema/decoding 补丁应用到运行版本', () => {
    const { version, applied } = applyAdapterToVersion(
      {
        systemPrompt: '你是助手',
        promptTemplate: '请处理：{{text}}',
        outputSchema: { title: { type: 'string' } },
      },
      {
        id: 'adapter-1',
        systemPromptAppend: '只输出 JSON。',
        userPromptAppend: '不要输出解释。',
        outputSchemaPatch: { summary: { type: 'string' } },
        decodingPatch: { temperature: 0.2, maxTokens: 1200 },
      },
    )

    expect(version.systemPrompt).toContain('只输出 JSON')
    expect(version.promptTemplate).toContain('不要输出解释')
    expect(version.outputSchema).toMatchObject({ title: { type: 'string' }, summary: { type: 'string' } })
    expect(version.adapterRuntime).toMatchObject({ adapterId: 'adapter-1', temperature: 0.2, maxTokens: 1200 })
    expect(applied?.adapterId).toBe('adapter-1')
  })

  it('按 skill + modelProfile/modelName + active 查找 adapter', async () => {
    const calls: any[] = []
    const payload = {
      find: async (args: any) => {
        calls.push(args)
        return { docs: [{ id: 'adapter-1' }] }
      },
    }

    await expect(
      findActiveAdapter(payload as any, {
        skillId: 's1',
        versionId: 'v1',
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
        modelProfile: 'profile-1',
      }),
    ).resolves.toMatchObject({ id: 'adapter-1' })
    expect(calls[0]).toMatchObject({
      collection: 'adapter-profiles',
      limit: 1,
      sort: '-liftScore',
      where: {
        and: [
          { skill: { equals: 's1' } },
          { or: [{ modelProfile: { equals: 'profile-1' } }, { modelName: { equals: 'qwen-plus' } }] },
          { or: [{ modelVersion: { equals: '2026-07-01' } }, { modelVersion: { exists: false } }] },
          { status: { equals: 'active' } },
          { or: [{ reviewStatus: { equals: 'approved' } }, { reviewStatus: { exists: false } }] },
          expect.any(Object),
        ],
      },
    })
  })

  it('适配补丁证据 hash 稳定且随关键补丁变化', () => {
    const base = {
      skill: 's1',
      skillVersion: 'v1',
      modelProfile: 'profile-1',
      modelName: 'qwen-plus',
      status: 'active',
      systemPromptAppend: '只输出 JSON。',
      decodingPatch: { temperature: 0.2 },
    }

    expect(buildAdapterEvidenceHash({ ...base })).toBe(buildAdapterEvidenceHash({ ...base }))
    expect(buildAdapterEvidenceHash({ ...base, systemPromptAppend: '只输出 YAML。' })).not.toBe(buildAdapterEvidenceHash(base))
  })

  it('collection hook 会写 evidenceHash 并落证据快照', async () => {
    const beforeChange = AdapterProfiles.hooks?.beforeChange?.[0] as any
    const afterChange = AdapterProfiles.hooks?.afterChange?.[0] as any
    const data = beforeChange({
      data: {
        skill: 's1',
        modelName: 'qwen-plus',
        status: 'active',
        reviewStatus: 'approved',
        systemPromptAppend: '只输出 JSON。',
      },
      originalDoc: {},
    })
    expect(data.evidenceHash).toHaveLength(64)
    expect(data.lastVerifiedAt).toBeTruthy()

    const creates: any[] = []
    await afterChange({
      doc: { id: 'adapter-1', ...data },
      req: {
        payload: {
          findGlobal: async () => ({}),
          create: async (args: any) => {
            creates.push(args)
            return { id: 'snap-1' }
          },
          logger: { warn: () => undefined, error: () => undefined },
        },
      },
    })
    expect(creates[0]).toMatchObject({
      collection: 'evidence-snapshots',
      data: { targetType: 'adapter_profile', targetId: 'adapter-1', evidenceHash: data.evidenceHash },
    })
  })

  it('collection hook 阻止创作者给他人 Skill 写 Adapter 补丁', async () => {
    const beforeValidate = AdapterProfiles.hooks?.beforeValidate?.[0] as any
    const payload = {
      findByID: async ({ collection, id }: any) => {
        if (collection === 'skills' && id === 's1') return { id: 's1', author: 'owner-1' }
        return null
      },
    }

    await expect(beforeValidate({
      data: { skill: 's1', modelName: 'qwen-plus' },
      req: { user: { id: 'user-2', role: 'creator' }, payload },
    })).rejects.toThrow('无权为他人的 Skill 创建或修改 Adapter')
  })

  it('collection hook 要求 Adapter 启用前先由审核员批准', async () => {
    const beforeValidate = AdapterProfiles.hooks?.beforeValidate?.[0] as any
    const payload = {
      findByID: async ({ collection, id }: any) => {
        if (collection === 'skills' && id === 's1') return { id: 's1', author: 'owner-1' }
        return null
      },
    }

    await expect(beforeValidate({
      data: { skill: 's1', modelName: 'qwen-plus', status: 'active' },
      req: { user: { id: 'owner-1', role: 'creator' }, payload },
    })).rejects.toThrow('Adapter 启用前必须由审核员批准')

    const data = await beforeValidate({
      data: { skill: 's1', modelName: 'qwen-plus', status: 'active' },
      req: { user: { id: 'reviewer-1', role: 'reviewer' }, payload },
    })
    expect(data.reviewStatus).toBe('approved')
  })

  it('collection hook 阻止创作者自行修改 Adapter 评审状态', async () => {
    const beforeValidate = AdapterProfiles.hooks?.beforeValidate?.[0] as any
    const payload = {
      findByID: async ({ collection, id }: any) => {
        if (collection === 'skills' && id === 's1') return { id: 's1', author: 'owner-1' }
        return null
      },
    }

    await expect(beforeValidate({
      data: { skill: 's1', modelName: 'qwen-plus', reviewStatus: 'approved' },
      originalDoc: { reviewStatus: 'pending' },
      req: { user: { id: 'owner-1', role: 'creator' }, payload },
    })).rejects.toThrow('只有审核员可以修改 Adapter 人工评审状态')
  })

  it('collection hook 校验 Adapter 的版本和失败案例必须归属同一 Skill', async () => {
    const beforeValidate = AdapterProfiles.hooks?.beforeValidate?.[0] as any
    const payload = {
      findByID: async ({ collection, id }: any) => {
        if (collection === 'skills' && id === 's1') return { id: 's1', author: 'owner-1' }
        if (collection === 'skill-versions' && id === 'v-other') return { id: 'v-other', skill: 's2' }
        if (collection === 'failure-cases' && id === 'f-other') return { id: 'f-other', skill: 's2' }
        return null
      },
    }

    await expect(beforeValidate({
      data: { skill: 's1', skillVersion: 'v-other', modelName: 'qwen-plus' },
      req: { user: { id: 'owner-1', role: 'creator' }, payload },
    })).rejects.toThrow('SkillVersion 不属于该 Skill')

    await expect(beforeValidate({
      data: { skill: 's1', sourceFailureCase: 'f-other', modelName: 'qwen-plus' },
      req: { user: { id: 'owner-1', role: 'creator' }, payload },
    })).rejects.toThrow('FailureCase 不属于该 Skill')
  })

  it('根据有无 adapterProfile 的兼容报告计算 lift', async () => {
    const lift = computeAdapterLift(
      [
        { success: false, formatValid: false, latencyMs: 200 },
        { success: true, formatValid: false, latencyMs: 100 },
      ],
      [
        { success: true, formatValid: true, latencyMs: 120 },
        { success: true, formatValid: true, latencyMs: 80 },
      ],
    )

    expect(lift.before).toMatchObject({ samples: 2, successRate: 0.5, formatRate: 0, avgLatencyMs: 150 })
    expect(lift.after).toMatchObject({ samples: 2, successRate: 1, formatRate: 1, avgLatencyMs: 100 })
    expect(lift.liftScore).toBe(65)
  })

  it('refreshAdapterLift 会写回 before/after/liftScore', async () => {
    const updates: any[] = []
    const finds: any[] = []
    const payload = {
      find: async (args: any) => {
        finds.push(args)
        const hasAdapter = JSON.stringify(args.where).includes('adapter-1')
        return { docs: hasAdapter ? [{ success: true, formatValid: true, latencyMs: 80 }] : [{ success: false, formatValid: false, latencyMs: 120 }] }
      },
      update: async (args: any) => {
        updates.push(args)
        return { id: args.id, ...args.data }
      },
    }

    await refreshAdapterLift(payload as any, { id: 'adapter-1', skill: 's1', modelName: 'qwen-plus', modelVersion: '2026-07-01' })
    expect(finds[0].where.and).toContainEqual({ modelVersion: { equals: '2026-07-01' } })
    expect(updates[0]).toMatchObject({
      collection: 'adapter-profiles',
      id: 'adapter-1',
      data: { liftScore: 100, beforeMetrics: { samples: 1 }, afterMetrics: { samples: 1 } },
    })
  })


  it('从 FailureCase 生成 Adapter 草稿数据', () => {
    const draft = buildAdapterDraftFromFailureCase({
      id: 'failure-1',
      title: 'JSON 格式错误 · qwen-plus',
      skill: 's1',
      skillVersion: 'v1',
      modelName: 'qwen-plus',
      primaryModelVersion: '2026-07-01',
      errorType: 'format_invalid',
      profileKey: 's1|small|format_invalid',
      primaryInputBucket: '0-100',
      repairTemplate: '强制输出 JSON。',
      verifyTemplate: '检查 JSON parse。',
    })

    expect(draft).toMatchObject({
      title: 'JSON 格式错误 · qwen-plus Adapter 草稿',
      skill: 's1',
      skillVersion: 'v1',
      sourceFailureCase: 'failure-1',
      modelName: 'qwen-plus',
      modelVersion: '2026-07-01',
      status: 'draft',
      reviewStatus: 'pending',
      failureTypes: ['format_invalid'],
      retryPolicy: { source: 'failure_case', profileKey: 's1|small|format_invalid' },
    })
    expect(draft.systemPromptAppend).toContain('强制输出 JSON')
    expect(draft.userPromptAppend).toContain('检查 JSON parse')
  })

  it('Skill 作者可从 FailureCase 创建 Adapter 草稿，重复调用返回既有草稿', async () => {
    const creates: any[] = []
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'failure-cases') {
          return {
            id: 'failure-1',
            skill: 's1',
            modelName: 'qwen-plus',
            primaryModelVersion: '2026-07-01',
            errorType: 'format_invalid',
            repairTemplate: '修复 JSON',
          }
        }
        if (args.collection === 'skills') return { id: 's1', title: '标题生成', author: 'user-1' }
        return null
      },
      find: async () => ({ docs: [] }),
      create: async (args: any) => {
        creates.push(args)
        return { id: 'adapter-1', ...args.data }
      },
    }

    const result = await createAdapterDraftFromFailureCase(payload as any, {
      userId: 'user-1',
      failureCaseId: 'failure-1',
    })

    expect(result).toMatchObject({ ok: true, adapter: { id: 'adapter-1', status: 'draft' } })
    expect(creates[0]).toMatchObject({
      collection: 'adapter-profiles',
      data: {
        skill: 's1',
        sourceFailureCase: 'failure-1',
        modelName: 'qwen-plus',
        modelVersion: '2026-07-01',
        status: 'draft',
        reviewStatus: 'pending',
      },
    })
  })

  it('Adapter 草稿响应摘要不暴露 prompt/schema/decoding 补丁正文', () => {
    const summary = adapterDraftSummary({
      id: 'adapter-1',
      title: 'JSON 修复草稿',
      skill: 'skill-1',
      skillVersion: 'version-1',
      sourceFailureCase: 'failure-1',
      modelName: 'qwen-plus',
      modelVersion: '2026-07-01',
      status: 'draft',
      reviewStatus: 'pending',
      failureTypes: ['format_invalid'],
      systemPromptAppend: '强制输出 JSON。',
      userPromptAppend: '检查 JSON parse。',
      outputSchemaPatch: { secret: true },
      decodingPatch: { temperature: 0.2 },
      createdAt: '2026-01-01T00:00:00.000Z',
    }) as any

    expect(summary).toMatchObject({
      id: 'adapter-1',
      skill: 'skill-1',
      skillVersion: 'version-1',
      sourceFailureCase: 'failure-1',
      modelName: 'qwen-plus',
      modelVersion: '2026-07-01',
      adminUrl: '/admin/collections/adapter-profiles/adapter-1',
      review: {
        decision: 'review',
        reviewStatus: 'pending',
        reviewChecklist: expect.arrayContaining([expect.stringContaining('未批准草稿不得进入公开 Adapter')]),
      },
    })
    expect(summary.systemPromptAppend).toBeUndefined()
    expect(summary.userPromptAppend).toBeUndefined()
    expect(summary.outputSchemaPatch).toBeUndefined()
    expect(summary.decodingPatch).toBeUndefined()
    expect(JSON.stringify(summary)).not.toContain('强制输出 JSON')
  })

  it('非作者不能从 FailureCase 创建 Adapter 草稿', async () => {
    const payload = {
      findByID: async (args: any) => {
        if (args.collection === 'failure-cases') return { id: 'failure-1', skill: 's1', modelName: 'qwen-plus' }
        if (args.collection === 'skills') return { id: 's1', author: 'owner-1' }
        return null
      },
    }

    await expect(createAdapterDraftFromFailureCase(payload as any, {
      userId: 'user-2',
      failureCaseId: 'failure-1',
    })).resolves.toMatchObject({ ok: false })
  })

})
