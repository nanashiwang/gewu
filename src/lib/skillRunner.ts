import type { Payload } from 'payload'
import { renderTemplate } from './promptRender'
import { validateInput, checkOutputFormat } from './schemaValidate'
import { selectModel } from './route'
import { chatCompletion, type NewApiResult } from './newapi'
import { estimateCost } from './cost'
import { generateRunId } from './slug'
import { skillRankFromAggregates } from './skillrank'
import { awardContribution } from './contribution'
import type { RouteMode } from './constants'

export interface RunSkillArgs {
  payload: Payload
  skill: any
  version: any
  input: Record<string, unknown>
  user?: { id: string } | null
  routeMode?: RouteMode
  userApiKey?: string
  forceModel?: string // 固定模型、不路由、不 fallback（多模型对比用）
  skipAggregate?: boolean // 跳过 Skill 指标更新与贡献值发放（对比模式避免污染聚合）
}

export interface RunSkillResult {
  ok: boolean
  runId: string
  errors?: string[]
  output?: string
  outputJson?: any
  model?: string
  routeMode?: RouteMode
  cost?: number
  latencyMs?: number
  tokens?: { prompt: number; completion: number; total: number }
  mocked?: boolean
  formatValid?: boolean
  skillRunId?: string
}

/** 运行编排：校验输入 → 渲染 → 选模型 → 调用(带 fallback) → 校验输出 → 写 SkillRun → 更新指标 → 发贡献值 */
export async function runSkill(args: RunSkillArgs): Promise<RunSkillResult> {
  const { payload, skill, version, input, user, routeMode, userApiKey } = args
  const runId = generateRunId()

  // 1. 校验输入
  const v = validateInput(version?.inputSchema, input)
  if (!v.valid) return { ok: false, runId, errors: v.errors }

  // 2. 渲染 Prompt（Spec v1：system + user 双段）
  const userContent = renderTemplate(version?.promptTemplate || '', input)
  const systemContent = renderTemplate(version?.systemPrompt || '', input)

  // 3. 选模型（forceModel 时固定模型、不路由、不 fallback —— 用于多模型对比）
  const fallbackDefault = process.env.MODEL_GATEWAY_DEFAULT_MODEL || 'claude-haiku-4-5-20251001'
  let model: string
  let fallbacks: string[]
  let mode: RouteMode
  if (args.forceModel) {
    model = args.forceModel
    fallbacks = []
    mode = routeMode || 'balanced'
  } else {
    ;({ model, fallbacks, mode } = selectModel(
      version?.routePolicy,
      version?.recommendedModels,
      routeMode,
      fallbackDefault,
    ))
  }

  // 4. 调用（主选失败则尝试 fallback）
  const messages = [
    ...(systemContent ? [{ role: 'system' as const, content: systemContent }] : []),
    { role: 'user' as const, content: userContent },
  ]
  const candidates = [model, ...fallbacks]
  let result: NewApiResult | null = null
  let usedModel = model
  let lastError: string | undefined
  for (const m of candidates) {
    try {
      result = await chatCompletion({
        model: m,
        messages,
        apiKey: userApiKey,
        metadata: {
          runId,
          skillId: skill?.id ? String(skill.id) : undefined,
          skillVersionId: version?.id ? String(version.id) : undefined,
          skillVersion: version?.version,
          source: 'hengshu',
        },
      })
      usedModel = m
      break
    } catch (e) {
      lastError = (e as Error).message
    }
  }
  const success = !!result

  // 5. 校验输出格式
  let formatValid = false
  let outputJson: any = null
  if (result) {
    const chk = checkOutputFormat(version?.outputSchema, result.text)
    formatValid = chk.formatValid
    outputJson = chk.outputJson
  }
  const cost = result ? estimateCost(usedModel, result.promptTokens, result.completionTokens) : 0

  // 6. 写 SkillRun
  let skillRunId: string | undefined
  try {
    const run = await payload.create({
      collection: 'skill-runs',
      overrideAccess: true,
      data: {
        runId,
        user: user?.id,
        skill: skill.id,
        skillVersion: version?.id,
        model: usedModel,
        routeMode: mode,
        inputJson: input,
        outputText: result?.text || lastError || '',
        outputJson,
        promptTokens: result?.promptTokens || 0,
        completionTokens: result?.completionTokens || 0,
        totalTokens: result?.totalTokens || 0,
        estimatedCost: cost,
        chargedAmount: cost,
        latencyMs: result?.latencyMs || 0,
        success,
        errorCode: success ? undefined : 'NEWAPI_ERROR',
        formatValid,
      },
    })
    skillRunId = run.id as string
  } catch (e) {
    payload.logger?.error(`写入 SkillRun 失败: ${(e as Error).message}`)
  }

  // 7. 更新 Skill 指标 + 发贡献值（对比模式 skipAggregate 跳过，避免污染聚合）
  if (!args.skipAggregate) {
    await updateSkillMetrics(payload, skill, {
      success,
      cost,
      latencyMs: result?.latencyMs || 0,
      formatValid,
    })

    // 成功调用 → 给作者 +0.1 贡献值
    if (success) {
      const authorId = typeof skill.author === 'object' ? skill.author?.id : skill.author
      if (authorId) {
        await awardContribution(payload, {
          userId: authorId,
          actionType: 'skill_run',
          points: 0.1,
          relatedSkill: skill.id,
          description: 'Skill 被成功调用',
        })
      }
    }
  }

  return {
    ok: success,
    runId,
    errors: success ? undefined : [lastError || '模型调用失败'],
    output: result?.text,
    outputJson,
    model: usedModel,
    routeMode: mode,
    cost,
    latencyMs: result?.latencyMs,
    tokens: result
      ? { prompt: result.promptTokens, completion: result.completionTokens, total: result.totalTokens }
      : undefined,
    mocked: result?.mocked,
    formatValid,
    skillRunId,
  }
}

async function updateSkillMetrics(
  payload: Payload,
  skill: any,
  r: { success: boolean; cost: number; latencyMs: number; formatValid: boolean },
) {
  try {
    const n = skill.runCount || 0
    const newCount = n + 1
    const avg = (prev: number, val: number) =>
      Math.round(((prev * n + val) / newCount) * 10000) / 10000
    const successRate = avg(skill.successRate || 0, r.success ? 1 : 0)
    const avgCost = avg(skill.avgCost || 0, r.cost || 0)
    const avgLatencyMs = Math.round(((skill.avgLatencyMs || 0) * n + (r.latencyMs || 0)) / newCount)
    const formatSuccessRate = avg(skill.formatSuccessRate || 0, r.formatValid ? 1 : 0)
    const skillRank = skillRankFromAggregates({
      successRate,
      avgCost,
      avgLatencyMs,
      formatSuccessRate,
      avgRating: skill.avgRating,
      lastUpdatedAt: skill.lastUpdatedAt,
    })
    await payload.update({
      collection: 'skills',
      id: skill.id,
      overrideAccess: true,
      data: {
        runCount: newCount,
        successRate,
        avgCost,
        avgLatencyMs,
        formatSuccessRate,
        lastRunAt: new Date().toISOString(),
        skillRank,
        healthScore: skillRank,
      },
    })
  } catch (e) {
    payload.logger?.error(`更新 Skill 指标失败: ${(e as Error).message}`)
  }
}
