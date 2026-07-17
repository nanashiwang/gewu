import type { Payload } from 'payload'
import { renderTemplate } from './promptRender'
import { validateInput, checkOutputFormat } from './schemaValidate'
import { rankPersonalizedRoute, selectModel } from './route'
import { chatCompletion, estimateTokens, redactGatewayErrorText, type NewApiResult } from './newapi'
import { estimateCost } from './cost'
import { anonHash, bucketSize, recomputeLocalScore } from './compat'
import { ensureModelProfile } from './modelProfile'
import { runResultLinks } from './runResultLinks'
import { generateRunId } from './slug'
import { skillRankFromAggregates } from './skillrank'
import { awardContribution } from './contribution'
import { applyCredit, creditsFromYuan } from './credit'
import { classifyError } from './errorTaxonomy'
import { getNewApiAdmin } from './newapiAdmin'
import { prepareNewApiSubTokenForRun, syncNewApiQuotaToBalance } from './newapiQuota'
import { approvedPlatformFallback, approvedPlatformModels, type RouteMode } from './constants'
import { consumeRunRateLimit } from './rateLimit'
import { resolveRuntimeEnv } from './deploymentSettings'
import { applyAdapterToVersion, findActiveAdapter, refreshAdapterLift } from './adapterProfile'
import { canUseEnterpriseSkill, recordEnterpriseRunAudit } from './enterprise'
import { refreshSkillPassport } from './passportRefresh'
import { refreshFailureCasesForSkill } from './failureRefresh'
import { evaluateBenchmarkCaseResult, type BenchmarkCaseScore } from './benchmarkScoring'
import { trustedCompatibleRunWhere } from './trustedRuns'

export interface RunSkillArgs {
  payload: Payload
  skill: any
  version: any
  input: Record<string, unknown>
  user?: { id: string } | null
  routeMode?: RouteMode
  userApiKey?: string
  modelProvider?: string
  modelVersion?: string
  forceModel?: string // 固定模型、不路由、不 fallback（多模型对比用）
  skipAggregate?: boolean // 跳过 Skill 指标更新与贡献值发放（对比模式避免污染聚合）
  skipCompatReport?: boolean // 企业私有评测等只留台账/审计，不写公开兼容证据
  benchmark?: boolean // 系统评测(#8)：不限频/不预检/不扣费/不排除自跑，compat 报告 source=benchmark
  benchmarkCase?: { id?: string; title?: string; expectedOutputShape?: unknown; requiredOutputPaths?: unknown; expectedTextIncludes?: unknown; minScore?: number }
  organizationId?: string // 企业 Registry 运行上下文；传入后强制校验组织批准和模型白名单
  enterprisePrivateBenchmark?: boolean // 企业管理员私有准入评测：调用方已完成 Registry 鉴权/策略检查
  enterpriseRegistryId?: string
  rerunOf?: string // 私人台账：从哪条历史运行换模型重跑
  rerunFromModel?: string
}

export interface RunSkillResult {
  ok: boolean
  runId: string
  errors?: string[]
  errorCode?: 'INSUFFICIENT_CREDIT' | 'MODEL_REQUIRES_BYOK' | 'RATE_LIMITED' | string
  output?: string
  outputJson?: any
  model?: string
  modelVersion?: string
  routeMode?: RouteMode
  cost?: number
  chargedCredits?: number // 平台代付路径实际扣减的 credit（BYOK/mock 为 0）
  savedAmount?: number // 成本优化回执：相比默认premium模型降低的估算元
  cheaperViaByok?: boolean // 四面墙·履约隔离：本次走平台代付，自带 Key 可直连供应商(不得隐藏)
  latencyMs?: number
  tokens?: { prompt: number; completion: number; total: number }
  mocked?: boolean
  formatValid?: boolean
  skillRunId?: string
  benchmarkScore?: BenchmarkCaseScore
  runLedgerUrl?: string
  modelProfileUrl?: string | null
  failureKnowledgeUrl?: string | null
}

// 每用户真实调用频控（60 秒窗口；Redis 原子计数优先，BYOK 可降级 DB 计数）
const DEFAULT_RUN_RATE_LIMIT_PER_MIN = 12
// 平台代付 credit 预检的输出 token 上限假设（预检用上限，实扣用真实用量）
const PRECHECK_COMPLETION_TOKENS = 2000

async function personalizedModelsForRun(
  payload: Payload,
  userId: string | undefined,
  skillId: string | undefined,
  mode: RouteMode,
): Promise<string[]> {
  if (!userId || !skillId) return []
  try {
    const res = await payload.find({
      collection: 'skill-runs',
      where: {
        and: [{ user: { equals: userId } }, { skill: { equals: skillId } }],
      },
      limit: 200,
      depth: 0,
      sort: '-createdAt',
      overrideAccess: true,
    })
    return rankPersonalizedRoute(
      (res.docs as any[]).filter((r) => r.countedInMetrics !== false),
      mode,
    )
  } catch (e) {
    payload.logger?.error(`个人化路由读取失败 user=${userId} skill=${skillId}: ${(e as Error).message}`)
    return []
  }
}

/** 运行编排：校验输入 → 渲染 → 选模型 → 调用(带 fallback) → 校验输出 → 写 SkillRun → 更新指标 → 发贡献值 */
export async function runSkill(args: RunSkillArgs): Promise<RunSkillResult> {
  const { payload, skill, version, input, user, routeMode, userApiKey } = args
  const runId = generateRunId()
  const runtimeEnv = await resolveRuntimeEnv(payload)
  const runRateLimitPerMin = Math.max(1, Number(runtimeEnv.RUN_RATE_LIMIT_PER_MIN || DEFAULT_RUN_RATE_LIMIT_PER_MIN))

  // 1. 校验输入
  const v = validateInput(version?.inputSchema, input)
  if (!v.valid) return { ok: false, runId, errors: v.errors }

  // 3. 选模型（forceModel 时固定模型、不路由、不 fallback —— 用于多模型对比）
  // 默认模型为已备案国产模型（合规架构切割 6l）：平台不代理未备案境外模型
  const fallbackDefault = runtimeEnv.MODEL_GATEWAY_DEFAULT_MODEL || 'deepseek-chat'
  let model: string
  let fallbacks: string[]
  let mode: RouteMode
  if (args.forceModel) {
    model = args.forceModel
    fallbacks = []
    mode = routeMode || 'balanced'
  } else {
    const requestedMode: RouteMode = routeMode || (version?.routePolicy?.default as RouteMode) || 'balanced'
    const personalized = !args.benchmark
      ? await personalizedModelsForRun(payload, user?.id, skill?.id ? String(skill.id) : undefined, requestedMode)
      : []
    ;({ model, fallbacks, mode } = selectModel(
      version?.routePolicy,
      version?.recommendedModels,
      requestedMode,
      fallbackDefault,
      { personalized },
    ))
  }

  let enterpriseRegistryId: string | undefined
  if (args.organizationId && user?.id && skill?.id) {
    if (args.enterprisePrivateBenchmark && args.enterpriseRegistryId) {
      enterpriseRegistryId = args.enterpriseRegistryId
    } else {
      const ent = await canUseEnterpriseSkill(payload, {
        userId: user.id,
        organizationId: args.organizationId,
        skillId: String(skill.id),
        modelName: model,
        input,
        routeMode: mode,
        byok: !!userApiKey,
      })
      if (!ent.ok) {
        await recordEnterpriseRunAudit(payload, {
          organizationId: args.organizationId,
          actorId: user.id,
          skillId: String(skill.id),
          skillVersionId: version?.id ? String(version.id) : undefined,
          runId,
          modelName: model,
          modelVersion: args.modelVersion,
          deniedReason: ent.reason,
          errorCode: 'ENTERPRISE_POLICY_DENIED',
          input,
        }).catch((e) => payload.logger?.error(`写入企业审计失败: ${(e as Error).message}`))
        return { ok: false, runId, errorCode: 'ENTERPRISE_POLICY_DENIED', errors: [ent.reason] }
      }
      enterpriseRegistryId = ent.registryId
    }
  }

  const selectedModelProfile = await ensureModelProfile(payload, model, args.modelProvider, args.modelVersion).catch(() => undefined)

  // 3a. 适配补丁：按 Skill × Model 应用 prompt/schema/decoding patch，让兼容层能修复而不只展示问题。
  const adapter = await findActiveAdapter(payload, {
    skillId: skill?.id ? String(skill.id) : undefined,
    versionId: version?.id ? String(version.id) : undefined,
    modelName: model,
    modelProfile: selectedModelProfile,
  })
  const adapted = applyAdapterToVersion(version, adapter)
  const runVersion = adapted.version

  // 2. 渲染 Prompt（Spec v1：system + user 双段；可能已叠加 Adapter prompt patch）
  const userContent = renderTemplate(runVersion?.promptTemplate || '', input)
  const systemContent = renderTemplate(runVersion?.systemPrompt || '', input)

  // 3b. 护栏（总纲 6a+6l）：mock 全免；BYOK 仅频控；平台代付=白名单+频控+credit 预检
  //     benchmark(系统评测 #8)：跳过频控/预检/扣费，但仍受白名单约束(合规)；不排除自跑、不计履约指标。
  const gatewayBaseUrl = runtimeEnv.MODEL_GATEWAY_BASE_URL?.trim()
  const gatewayKey = runtimeEnv.MODEL_GATEWAY_KEY?.trim()
  const gatewayBaseConfigured = !!gatewayBaseUrl
  const adminForRun = getNewApiAdmin(runtimeEnv)
  const platformKeyPath =
    gatewayBaseConfigured && !userApiKey && (!!gatewayKey || adminForRun.mode === 'real')
  const isRealCall = gatewayBaseConfigured && !!(userApiKey || gatewayKey || platformKeyPath)

  if (!isRealCall && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      runId,
      errorCode: 'MODEL_GATEWAY_NOT_CONFIGURED',
      errors: ['管理员尚未配置模型网关；请在后台「部署设置」填写网关地址和 Key，或使用自带 Key。'],
    }
  }

  if (isRealCall && user?.id && !args.benchmark) {
    const rateLimit = await consumeRunRateLimit({
      payload,
      userId: user.id,
      limit: runRateLimitPerMin,
      platformPaid: platformKeyPath,
    })
    if (!rateLimit.allowed) {
      return {
        ok: false,
        runId,
        errorCode: 'RATE_LIMITED',
        errors: [
          rateLimit.unavailable
            ? '系统繁忙，请稍后再试'
            : `运行过于频繁（每分钟上限 ${runRateLimitPerMin} 次），请稍后再试`,
        ],
      }
    }
  }

  let preCheckedUserBalance: number | null = null
  let platformCallApiKey = userApiKey
  let platformMaxTokens: number | undefined // 平台代付时把预检上限作为硬约束传给网关，防超额透支
  if (platformKeyPath) {
    // 生产平台代付必须走用户子令牌；只配置全局 MODEL_GATEWAY_KEY 不能上线，避免绕过 per-user quota 隔离。
    if (!args.benchmark && adminForRun.mode !== 'real' && process.env.NODE_ENV === 'production') {
      return {
        ok: false,
        runId,
        errorCode: 'PLATFORM_TOKEN_UNAVAILABLE',
        errors: ['平台子令牌未配置，请改用自带 Key（BYOK）或稍后再试'],
      }
    }

    // 白名单：平台代付仅限已备案国产模型；候选链过滤，境外模型请 BYOK
    const approved = approvedPlatformModels(runtimeEnv)
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
      // 正常路由场景：作者 routePolicy/环境默认全是境外模型时，平台代付降级到已备案国产模型。
      const safeFallback = approvedPlatformFallback(fallbackDefault, runtimeEnv)
      if (!safeFallback) {
        return {
          ok: false,
          runId,
          errorCode: 'MODEL_REQUIRES_BYOK',
          errors: ['平台代付模型白名单为空，请自带 Key（BYOK）调用'],
        }
      }
      chain = [safeFallback]
    }
    model = chain[0]
    fallbacks = chain.slice(1)
    platformMaxTokens = PRECHECK_COMPLETION_TOKENS

    // credit 预检：按 prompt 实估 + 输出上限假设，余额不足直接拒（不产生任何调用成本）。benchmark 系统评测跳过。
    if (args.benchmark) {
      /* 系统评测不预检、不扣费（成本记平台，四面墙 margin=0） */
    } else if (user?.id) {
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
            `credit 余额不足：本次预估最高需 ${ceilingCredits} credit，当前余额 ${preCheckedUserBalance}。可自带 Key（BYOK）免扣费运行，或通过贡献值兑换获取 credit`,
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

    // RealAdmin 模式下，平台代付必须使用该用户的 New API 子令牌，不能再走全局平台 Key。
    // stub 模式保留全局 Key 路径，方便本地开发；生产若子令牌不可用则 fail-closed。
    if (!args.benchmark && user?.id) {
      const admin = adminForRun
      if (admin.mode === 'real') {
        try {
          const tok = await prepareNewApiSubTokenForRun(admin, user.id, preCheckedUserBalance || 0)
          if (!tok.key) {
            return {
              ok: false,
              runId,
              errorCode: 'PLATFORM_TOKEN_UNAVAILABLE',
              errors: ['平台子令牌未就绪，请稍后重试或改用自带 Key（BYOK）'],
            }
          }
          platformCallApiKey = tok.key
        } catch (e) {
          payload.logger?.error(`平台子令牌准备失败 user=${user.id}: ${(e as Error).message}`)
          return {
            ok: false,
            runId,
            errorCode: 'PLATFORM_TOKEN_UNAVAILABLE',
            errors: ['平台子令牌暂不可用，请稍后重试或改用自带 Key（BYOK）'],
          }
        }
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
        apiKey: platformCallApiKey,
        temperature: runVersion?.adapterRuntime?.temperature,
        maxTokens: platformMaxTokens || runVersion?.adapterRuntime?.maxTokens, // 平台代付：硬约束输出上限优先，BYOK 可用 Adapter 上限
        gateway: { baseUrl: gatewayBaseUrl, apiKey: gatewayKey },
        metadata: {
          runId,
          skillId: skill?.id ? String(skill.id) : undefined,
          skillVersionId: version?.id ? String(version.id) : undefined,
          skillVersion: version?.version,
          source: 'gewu',
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
    const chk = checkOutputFormat(runVersion?.outputSchema, result.text)
    formatValid = chk.formatValid
    outputJson = chk.outputJson
  }
  const cost = result ? estimateCost(usedModel, result.promptTokens, result.completionTokens) : 0

  // 成本优化回执(#15后半/#16)：相比作者默认premium模型，本次成本优化路由降低多少成本（估算元，≥0）。
  // 参照=作者首选云模型/balanced首选，若与实际同模型或更便宜则降本 0。这是不随30天半衰期归零的累计留存资产。
  const refModel =
    runVersion?.recommendedModels?.cloud?.[0] || runVersion?.routePolicy?.strategies?.balanced?.[0] || fallbackDefault
  let savedAmount = 0
  if (result && refModel && refModel !== usedModel) {
    const refCost = estimateCost(refModel, result.promptTokens, result.completionTokens)
    savedAmount = Math.max(0, Math.round((refCost - cost) * 10000) / 10000)
  }

  // 结构化错误分类（6m 负知识原料）：调用失败原因 / 成功但格式漂移，仅存标签不存原文
  const outputSchemaPresent = !!runVersion?.outputSchema && Object.keys(runVersion.outputSchema).length > 0
  const errorType = classifyError({
    hasResult: !!result,
    lastError,
    formatValid,
    outputSchemaPresent,
    text: result?.text,
  })
  const runModelVersion = usedModel === model ? args.modelVersion : undefined
  const runModelProvider = usedModel === model ? args.modelProvider : undefined
  const runModelProfile = usedModel === model
    ? selectedModelProfile
    : await ensureModelProfile(payload, usedModel, runModelProvider, runModelVersion).catch(() => undefined)

  // 5b. credit 消费出口（总纲 6a，三币漏斗"跑模型→蒸发"段）：仅平台代付且真实调用时扣。
  //     幂等键=runId 防重试双扣；预检已兜底，实扣允许轻微透支保台账真实（账实一致优先于余额非负）。
  let chargedCredits = 0
  if (platformKeyPath && !args.benchmark && result && !result.mocked && user?.id) {
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
      } else if (!charge.skipped) {
        // 网关也会扣子令牌 quota；本地扣费提交后按权威余额回推绝对 quota，防刻度误差/异步漂移累积。
        syncNewApiQuotaToBalance(payload, user.id).catch((e) =>
          payload.logger?.error(`运行后网关配额同步失败 run=${runId}: ${(e as Error).message}`),
        )
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
        rerunOf: args.rerunOf,
        rerunFromModel: args.rerunFromModel,
        adapterProfile: adapted.applied?.adapterId,
        modelProfile: runModelProfile,
        modelVersion: runModelVersion,
        model: usedModel,
        routeMode: mode,
        inputJson: input,
        outputText: result?.text || (errorType ? `模型调用失败（${errorType}）` : '模型调用失败'),
        outputJson,
        promptTokens: result?.promptTokens || 0,
        completionTokens: result?.completionTokens || 0,
        totalTokens: result?.totalTokens || 0,
        estimatedCost: cost,
        chargedAmount: chargedCredits > 0 ? cost : 0, // 仅平台代付且扣费成功计费；BYOK/失败记 0
        chargedCredits,
        savedAmount,
        latencyMs: result?.latencyMs || 0,
        success,
        errorCode: errorType || (success ? undefined : 'NEWAPI_ERROR'),
        formatValid,
        // 对比/探测(skipAggregate)不计入 headline 指标；持久化该意图供台账对账过滤，避免重算时把探测运行错误计入
        countedInMetrics: !args.skipAggregate,
      } as any,
    })
    skillRunId = run.id as string
  } catch (e) {
    payload.logger?.error(`写入 SkillRun 失败: ${(e as Error).message}`)
  }

  if (args.organizationId && skill?.id) {
    await recordEnterpriseRunAudit(payload, {
      organizationId: args.organizationId,
      registryId: enterpriseRegistryId,
      actorId: user?.id,
      skillId: String(skill.id),
      skillVersionId: version?.id ? String(version.id) : undefined,
      skillRunId,
      runId,
      modelName: usedModel,
      modelVersion: runModelVersion,
      modelProfile: runModelProfile,
      success,
      errorCode: errorType || (success ? undefined : 'NEWAPI_ERROR'),
      input,
      outputText: result?.text,
      latencyMs: result?.latencyMs || 0,
      estimatedCost: cost,
      chargedCredits,
      metadata: { routeMode: mode, fallbackUsed: usedModel !== model, skipAggregate: !!args.skipAggregate },
    }).catch((e) => payload.logger?.error(`写入企业审计失败: ${(e as Error).message}`))
  }

  const benchmarkScore = args.benchmark
    ? evaluateBenchmarkCaseResult({
        ok: success,
        formatValid,
        output: result?.text,
        outputJson,
        testCase: args.benchmarkCase,
      })
    : undefined

  // 6b. 在线回流兼容报告（护城河水龙头 + 负知识水龙头 6m）：真实调用(含失败)喂逐模型评测数据（不含原文）。
  //     排除 mock 与作者自跑（防自刷）；失败也回流（带 errorType），是负知识库的原料来源。
  {
    const runAuthorId = typeof skill.author === 'object' ? skill.author?.id : skill.author
    const isSelfRun = !!(user?.id && runAuthorId && String(user.id) === String(runAuthorId))
    const uHash = user?.id ? anonHash(String(user.id)) : undefined
    // benchmark(系统评测)：source=benchmark、不排除自跑(平台代作者评测)、不受单用户封顶；否则 online 用户回流
    const reportSource = args.benchmark ? 'benchmark' : 'online'
    // isRealCall=真实尝试（网关已配+有 Key）：成功则 result 非 mock，失败则 result 为 null 但仍是真实尝试
    if (isRealCall && !args.skipCompatReport && (args.benchmark || !isSelfRun) && !(result && result.mocked)) {
      try {
        // 抗刷：同一用户对同一 (skill, model) 的 online 报告最多计 3 条（benchmark 无此限，系统可信）
        let allow = true
        if (!args.benchmark && uHash) {
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
              modelProfile: runModelProfile,
              modelVersion: runModelVersion,
              adapterProfile: adapted.applied?.adapterId,
              benchmarkCase: args.benchmarkCase?.id,
              benchmarkScore: benchmarkScore?.score,
              benchmarkPassed: benchmarkScore?.passed,
              success,
              formatValid,
              latencyMs: result?.latencyMs || 0,
              errorType, // 6m 负知识：失败原因/格式漂移分类
              inputSizeBucket: bucketSize(JSON.stringify(input || {}).length),
              outputSizeBucket: bucketSize((result?.text || '').length),
              source: reportSource,
            },
          })
          if (!args.skipAggregate && !args.benchmark) {
            await recomputeLocalScore(payload, String(skill.id))
            await refreshSkillPassport(payload, String(skill.id))
          }
          if (adapted.applied?.adapterId) {
            await refreshAdapterLift(payload, { id: adapted.applied.adapterId, skill: skill.id, modelName: usedModel, modelVersion: runModelVersion }).catch((e) =>
              payload.logger?.error(`刷新 Adapter lift 失败: ${(e as Error).message}`),
            )
          }
          if (errorType) {
            await refreshFailureCasesForSkill(payload, String(skill.id))
          }
        }
      } catch (e) {
        payload.logger?.error(`写入在线兼容报告/刷新兼容聚合失败: ${(e as Error).message}`)
      }
    }
  }

  // 7. 更新 Skill 指标 + 发贡献值（对比模式 skipAggregate 跳过，避免污染聚合）
  if (!args.skipAggregate) {
    await updateSkillMetrics(payload, skill, version, {
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

  // 失败对外只给归一化文案（errorType），不透传上游网关原始错误体(可能含内部路由/分组/配额细节)
  if (!success && lastError) payload.logger?.error(`运行失败 run=${runId} model=${usedModel}: ${redactGatewayErrorText(lastError)}`)
  const publicError = success
    ? undefined
    : [errorType ? `模型调用失败（${errorType}），请重试或更换模型` : '模型调用失败，请重试或更换模型']

  return {
    ok: success,
    runId,
    errors: publicError,
    errorCode: success ? undefined : errorType,
    output: result?.text,
    outputJson,
    model: usedModel,
    modelVersion: runModelVersion,
    routeMode: mode,
    cost,
    chargedCredits,
    savedAmount,
    // 四面墙·履约隔离：平台代付含加价，自带 Key 可直连供应商——强制回传，不得隐藏(网关抄不起的诚实)
    cheaperViaByok: platformKeyPath && !args.benchmark && !!result && !result.mocked,
    latencyMs: result?.latencyMs,
    tokens: result
      ? { prompt: result.promptTokens, completion: result.completionTokens, total: result.totalTokens }
      : undefined,
    mocked: result?.mocked,
    formatValid,
    skillRunId,
    benchmarkScore,
    ...runResultLinks({
      skillId: skill.id,
      model: usedModel,
      modelVersion: runModelVersion,
      errorCode: success ? undefined : errorType,
      success,
    }),
  }
}

async function updateSkillMetrics(
  payload: Payload,
  skill: any,
  version: any,
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
    const trustedCompatibleRuns = await payload.count({
      collection: 'skill-runs' as any,
      where: trustedCompatibleRunWhere(undefined, {
        skillId: String(skill.id),
        versionId: version?.id ? String(version.id) : undefined,
      }),
      overrideAccess: true,
    }).catch(() => ({ totalDocs: undefined }))
    const skillRank = skillRankFromAggregates({
      successRate,
      avgCost,
      avgLatencyMs,
      formatSuccessRate,
      avgRating: skill.avgRating,
      trustedCompatibleRunCount: trustedCompatibleRuns.totalDocs,
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
