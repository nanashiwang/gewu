import type { Payload } from 'payload'
import { renderTemplate } from './promptRender'
import { validateInput, checkOutputFormat } from './schemaValidate'
import { selectModel } from './route'
import { chatCompletion, estimateTokens, type NewApiResult } from './newapi'
import { estimateCost } from './cost'
import { anonHash, bucketSize } from './compat'
import { generateRunId } from './slug'
import { skillRankFromAggregates } from './skillrank'
import { awardContribution } from './contribution'
import { applyCredit, creditsFromYuan } from './credit'
import { approvedPlatformModels, type RouteMode } from './constants'

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
  errorCode?: 'INSUFFICIENT_CREDIT' | 'MODEL_REQUIRES_BYOK' | 'RATE_LIMITED' | string
  output?: string
  outputJson?: any
  model?: string
  routeMode?: RouteMode
  cost?: number
  chargedCredits?: number // 平台代付路径实际扣减的 credit（BYOK/mock 为 0）
  latencyMs?: number
  tokens?: { prompt: number; completion: number; total: number }
  mocked?: boolean
  formatValid?: boolean
  skillRunId?: string
}

// 每用户真实调用频控（60 秒窗口，按 skill-runs 落库行计数——保护的是钱与网关，不是 CPU）
const RUN_RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.RUN_RATE_LIMIT_PER_MIN || 12))
// 平台代付 credit 预检的输出 token 上限假设（预检用上限，实扣用真实用量）
const PRECHECK_COMPLETION_TOKENS = 2000

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
  // 默认模型为已备案国产模型（合规架构切割 6l）：平台不代理未备案境外模型
  const fallbackDefault = process.env.MODEL_GATEWAY_DEFAULT_MODEL || 'deepseek-chat'
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

  // 3b. 护栏（总纲 6a+6l）：mock 全免；BYOK 仅频控；平台代付=白名单+频控+credit 预检
  const gatewayConfigured = !!process.env.MODEL_GATEWAY_BASE_URL?.trim()
  const platformKeyPath =
    gatewayConfigured && !userApiKey && !!process.env.MODEL_GATEWAY_KEY?.trim()
  const isRealCall = gatewayConfigured && !!(userApiKey || process.env.MODEL_GATEWAY_KEY?.trim())

  if (isRealCall && user?.id) {
    // 频控：60 秒窗口内该用户已落库运行数（护栏拒绝不写行，故只计真实执行）
    try {
      const winStart = new Date(Date.now() - 60_000).toISOString()
      const recent = await payload.count({
        collection: 'skill-runs',
        where: {
          and: [{ user: { equals: user.id } }, { createdAt: { greater_than_equal: winStart } }],
        },
        overrideAccess: true,
      })
      if (recent.totalDocs >= RUN_RATE_LIMIT_PER_MIN) {
        return {
          ok: false,
          runId,
          errorCode: 'RATE_LIMITED',
          errors: [`运行过于频繁（每分钟上限 ${RUN_RATE_LIMIT_PER_MIN} 次），请稍后再试`],
        }
      }
    } catch (e) {
      // 钱相关 fail-closed：平台代付路径频控查询失败则拒绝（防 DB 抖动期被利用关闭频控刷平台代付）；
      // BYOK 用户自付，查询失败放行不影响平台成本。
      payload.logger?.error(`运行频控检查失败: ${(e as Error).message}`)
      if (platformKeyPath) {
        return {
          ok: false,
          runId,
          errorCode: 'RATE_LIMITED',
          errors: ['系统繁忙，请稍后再试'],
        }
      }
    }
  }

  let preCheckedUserBalance: number | null = null
  let platformMaxTokens: number | undefined // 平台代付时把预检上限作为硬约束传给网关，防超额透支
  if (platformKeyPath) {
    // 白名单：平台代付仅限已备案国产模型；候选链过滤，境外模型请 BYOK
    const approved = approvedPlatformModels()
    let chain = [model, ...fallbacks].filter((m) => approved.has(m))
    if (chain.length === 0) {
      if (args.forceModel) {
        // 对比/指定模型场景：明确提示该模型需 BYOK，不静默改跑别的模型
        return {
          ok: false,
          runId,
          errorCode: 'MODEL_REQUIRES_BYOK',
          errors: [`模型 ${model} 仅支持自带 Key（BYOK）调用；平台代付仅限已备案国产模型`],
        }
      }
      // 正常路由场景：作者 routePolicy 全是境外模型时，平台代付降级到已备案国产默认模型（合规兜底，避免 403 跑不通）
      chain = [fallbackDefault]
    }
    model = chain[0]
    fallbacks = chain.slice(1)
    platformMaxTokens = PRECHECK_COMPLETION_TOKENS

    // credit 预检：按 prompt 实估 + 输出上限假设，余额不足直接拒（不产生任何调用成本）
    if (user?.id) {
      try {
        const u = (await payload.findByID({
          collection: 'users',
          id: user.id,
          overrideAccess: true,
          depth: 0,
        })) as any
        preCheckedUserBalance = u?.creditBalance || 0
      } catch {
        preCheckedUserBalance = 0
      }
      // ceiling 取候选链中最贵模型（防主选便宜、fallback 更贵导致透支）
      const promptTokens = estimateTokens(`${systemContent}\n${userContent}`)
      const ceilingYuan = Math.max(
        ...chain.map((m) => estimateCost(m, promptTokens, PRECHECK_COMPLETION_TOKENS)),
      )
      const ceilingCredits = creditsFromYuan(ceilingYuan)
      if ((preCheckedUserBalance || 0) < ceilingCredits) {
        return {
          ok: false,
          runId,
          errorCode: 'INSUFFICIENT_CREDIT',
          errors: [
            `credit 余额不足：本次预估最高需 ${ceilingCredits} credit，当前余额 ${preCheckedUserBalance}。可自带 Key（BYOK）免扣费运行，或通过术值兑换获取 credit`,
          ],
        }
      }
    } else {
      // 平台代付必须可记账：无用户身份不放行（当前调用链恒有 user，防御性拦截）
      return {
        ok: false,
        runId,
        errorCode: 'INSUFFICIENT_CREDIT',
        errors: ['平台代付需要登录账户以扣减 credit'],
      }
    }
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
        maxTokens: platformMaxTokens, // 平台代付：硬约束输出上限=预检假设，杜绝超额透支；BYOK/mock 为 undefined 不限制
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

  // 5b. credit 消费出口（总纲 6a，三币漏斗"跑模型→蒸发"段）：仅平台代付且真实调用时扣。
  //     幂等键=runId 防重试双扣；预检已兜底，实扣允许轻微透支保台账真实（账实一致优先于余额非负）。
  let chargedCredits = 0
  if (platformKeyPath && result && !result.mocked && user?.id) {
    chargedCredits = creditsFromYuan(cost)
    if (chargedCredits > 0) {
      const charge = await applyCredit(payload, {
        userId: user.id,
        type: 'consume',
        amount: -chargedCredits,
        description: `运行 ${skill?.title || skill?.slug || 'Skill'}（${usedModel}）`,
        idempotencyKey: `run:${runId}`,
        allowNegativeBalance: true,
      })
      if (!charge.ok) {
        // 扣费失败：不虚报已扣，chargedCredits 归 0，chargedAmount 也据此记 0，留待对账补扣
        payload.logger?.error(`运行扣费失败 run=${runId}: ${charge.error || '未知'}`)
        chargedCredits = 0
      }
    }
  }

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
        chargedAmount: chargedCredits > 0 ? cost : 0, // 仅平台代付且扣费成功计费；BYOK/失败记 0
        latencyMs: result?.latencyMs || 0,
        success,
        errorCode: success ? undefined : 'NEWAPI_ERROR',
        formatValid,
        // 对比/探测(skipAggregate)不计入 headline 指标；持久化该意图供台账对账过滤，避免重算时把探测运行错误计入
        countedInMetrics: !args.skipAggregate,
      },
    })
    skillRunId = run.id as string
  } catch (e) {
    payload.logger?.error(`写入 SkillRun 失败: ${(e as Error).message}`)
  }

  // 6b. 在线运行回流兼容报告（护城河水龙头）：真实非 mock 调用喂逐模型评测数据（不含输入/输出原文）。
  //     排除作者自跑（防自刷兼容矩阵）；不随 skipAggregate 跳过——对比模式正是要采集的信号。
  {
    const runAuthorId = typeof skill.author === 'object' ? skill.author?.id : skill.author
    const isSelfRun = !!(user?.id && runAuthorId && String(user.id) === String(runAuthorId))
    const uHash = user?.id ? anonHash(String(user.id)) : undefined
    if (result && !result.mocked && !isSelfRun) {
      try {
        // 抗刷：同一用户对同一 (skill, model) 的 online 报告最多计 3 条，防单人灌满/反向投毒某格
        let allow = true
        if (uHash) {
          const existing = await payload.count({
            collection: 'compat-reports',
            where: {
              and: [
                { skill: { equals: skill.id } },
                { modelName: { equals: usedModel } },
                { anonymousUserHash: { equals: uHash } },
                { source: { equals: 'online' } },
              ],
            },
            overrideAccess: true,
          })
          allow = existing.totalDocs < 3
        }
        if (allow) {
          await payload.create({
            collection: 'compat-reports',
            overrideAccess: true,
            data: {
              skill: skill.id,
              skillVersion: version?.id,
              anonymousUserHash: uHash,
              modelName: usedModel,
              success,
              formatValid,
              latencyMs: result.latencyMs || 0,
              inputSizeBucket: bucketSize(JSON.stringify(input || {}).length),
              outputSizeBucket: bucketSize((result.text || '').length),
              source: 'online',
            },
          })
        }
      } catch (e) {
        payload.logger?.error(`写入在线兼容报告失败: ${(e as Error).message}`)
      }
    }
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
          actorId: user?.id,
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
    chargedCredits,
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
