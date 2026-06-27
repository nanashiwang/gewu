import { getPayload } from 'payload'
import config from '@payload-config'
import { runnerFromBearer } from '@/lib/runnerAuth'
import { resolvePublishedSkill } from '@/lib/installs'
import { anonHash, recomputeLocalScore } from '@/lib/compat'
import { awardContribution } from '@/lib/contribution'

// POST /v1/runner/report (Bearer) —— 提交本地模型兼容报告
// 仅接受可聚合指标，绝不存输入/输出原文。anon=true 时只存匿名哈希、不关联用户。
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const actor = await runnerFromBearer(payload, request)
  if (!actor) return Response.json({ error: '未登录或令牌无效' }, { status: 401 })

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '请求体无效' }, { status: 400 })
  }
  const slug = String(body.slug || '').trim()
  if (!slug || !body.model) {
    return Response.json({ error: '缺少 slug 或 model' }, { status: 400 })
  }

  const resolved = await resolvePublishedSkill(payload, slug)
  if (!resolved) return Response.json({ error: 'Skill 不存在' }, { status: 404 })

  const anon = !!body.anon
  const isVerified = actor.runner.trustedLevel === 'verified'
  // 白名单：仅以下字段会被存储
  await payload.create({
    collection: 'compat-reports',
    overrideAccess: true,
    data: {
      skill: resolved.skill.id,
      skillVersion: resolved.version.id,
      runner: anon ? undefined : actor.runner.id,
      anonymousUserHash: anon ? anonHash(actor.runner.runnerId) : undefined,
      modelProvider: String(body.modelProvider || '').slice(0, 60) || undefined,
      modelName: String(body.model).slice(0, 120),
      modelVersion: body.modelVersion ? String(body.modelVersion).slice(0, 60) : undefined,
      success: !!body.success,
      latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : undefined,
      formatValid: !!body.formatValid,
      errorType: body.errorType ? String(body.errorType).slice(0, 60) : undefined,
      inputSizeBucket: body.inputSizeBucket ? String(body.inputSizeBucket).slice(0, 16) : undefined,
      outputSizeBucket: body.outputSizeBucket ? String(body.outputSizeBucket).slice(0, 16) : undefined,
      runnerVersion: actor.runner.runnerVersion,
      source: isVerified ? 'verified' : 'community',
    },
  })

  const localScore = await recomputeLocalScore(payload, resolved.skill.id)

  // 信任模型：仅 verified Runner 的具名报告计术值（社区报告仅展示）
  let rewarded = false
  if (isVerified && !anon) {
    await awardContribution(payload, {
      userId: actor.user.id,
      actionType: 'compat_report',
      relatedSkill: resolved.skill.id,
      description: `提交「${resolved.skill.title}」兼容报告`,
    })
    rewarded = true
  }

  return Response.json({ ok: true, localScore, rewarded })
}
