import type { Payload } from 'payload'
import { createHmac, createHash } from 'crypto'
import { rankDataDrivenRoute } from './route'
import { canonicalString } from './canonical'
import { signCanonical, getSigningKeyId } from './signing'

// 规模分档（避免回传精确长度）
export function bucketSize(n: number): string {
  const v = n || 0
  if (v < 100) return '0-100'
  if (v < 500) return '100-500'
  if (v < 2000) return '500-2k'
  if (v < 8000) return '2k-8k'
  return '8k+'
}

// 匿名标识：HMAC(runnerId + 服务端 salt)，不可逆向到 user
export function anonHash(runnerId: string): string {
  return createHmac('sha256', process.env.PAYLOAD_SECRET || 'hengshu-salt')
    .update(String(runnerId))
    .digest('hex')
    .slice(0, 32)
}

// ── 护城河第0层：活体数据聚合 ──
// 近期数据主导（模型月更、旧样本会腐坏）：按时间指数衰减加权；样本稀疏则诚实标注、不用误导性百分比霸榜。
const HALF_LIFE_DAYS = 30 // 半衰期：30 天前的报告权重减半
const MIN_MODEL_SAMPLE = 5 // 单模型报告数 < 此值 → lowSample（前端显示"战绩积累中"而非百分比）
const CONF_FULL_N = 10 // LocalScore 置信满额所需的有效(衰减)样本量；不足则按置信度衰减分数

function decayWeight(createdAt: unknown, nowMs: number): number {
  const t = createdAt ? new Date(createdAt as string).getTime() : NaN
  // 缺失/非法时间戳按 0 权重（不计入），避免"无时间"被当作"最新报告"霸榜/被利用
  if (!Number.isFinite(t)) return 0
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000)
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

// 来源分级权重：verified/benchmark(系统评测) 最可信、community 次之、online(在线试用) 最低——削弱在线通道刷分/投毒杠杆
const SOURCE_WEIGHT: Record<string, number> = { verified: 1, benchmark: 1, community: 0.5, online: 0.3 }
function sourceWeight(source: unknown): number {
  return SOURCE_WEIGHT[String(source)] ?? 0.5
}

// 由兼容报告聚合重算 Skill 的 LocalScore（0-100）并写回（衰减加权 × 来源权重 + 置信度衰减）
export async function recomputeLocalScore(payload: Payload, skillId: string) {
  const prevSkill = (await payload
    .findByID({ collection: 'skills', id: skillId, depth: 0, overrideAccess: true })
    .catch(() => null)) as any
  const prevScore: number | null = prevSkill ? prevSkill.localScore ?? 0 : null
  const res = await payload.find({
    collection: 'compat-reports',
    where: { skill: { equals: skillId } },
    limit: 5000,
    depth: 0,
    overrideAccess: true,
  })
  const reports = res.docs as any[]
  let localScore = 0
  if (reports.length > 0) {
    const now = Date.now()
    let wSum = 0
    let wSuccess = 0
    let wFormat = 0
    const models = new Set<string>()
    for (const r of reports) {
      const w = r.suppressed ? 0 : decayWeight(r.createdAt, now) * sourceWeight(r.source)
      wSum += w
      if (r.success) wSuccess += w
      if (r.formatValid) wFormat += w
      if (r.modelName) models.add(r.modelName)
    }
    if (wSum > 0) {
      const successRate = wSuccess / wSum
      const formatRate = wFormat / wSum
      const coverage = Math.min(1, models.size / 3)
      const base = 0.6 * successRate + 0.3 * formatRate + 0.1 * coverage
      // 置信度：有效(衰减)样本不足时按比例衰减分数，杜绝 N=1 的 100% 噪声霸榜
      const confidence = Math.min(1, wSum / CONF_FULL_N)
      localScore = Math.round(100 * base * confidence)
    }
  }
  await payload.update({
    collection: 'skills',
    id: skillId,
    data: { localScore },
    overrideAccess: true,
  })
  // 6j-2 信任加固：分数变化时落一条 ed25519 签名的 append-only 快照，改历史必留痕。失败不影响主流程。
  try {
    if (localScore !== (prevScore ?? -1)) {
      await writeScoreSnapshot(payload, skillId, localScore, reports.length)
    }
  } catch (e) {
    payload.logger?.error(`writeScoreSnapshot 失败: ${(e as Error).message}`)
  }
  // 护城河第1层(#15)：由真实回流回写省钱路由，让"数据改变产品动作"而非只改展示。失败不影响 localScore。
  try {
    await recomputeRoutePolicy(payload, skillId)
  } catch (e) {
    payload.logger?.error(`recomputeRoutePolicy 失败: ${(e as Error).message}`)
  }
  return localScore
}

// 6j-2：写一条 ed25519 签名的 append-only 分数快照。无签名密钥时仍落记录(带哈希)，仅 signature 为空。
async function writeScoreSnapshot(
  payload: Payload,
  skillId: string,
  localScore: number,
  reportCount: number,
): Promise<void> {
  const signedAt = new Date().toISOString()
  const core = { skill: String(skillId), localScore, reportCount, signedAt }
  const canon = canonicalString(core)
  const payloadHash = createHash('sha256').update(canon).digest('hex')
  const signature = signCanonical(core) // 无密钥返回 null
  const keyId = getSigningKeyId() // 无密钥返回 null
  await payload.create({
    collection: 'score-snapshots',
    overrideAccess: true,
    data: {
      skill: skillId,
      localScore,
      reportCount,
      payloadHash,
      keyId: keyId || undefined,
      signature: signature || undefined,
      signedAt,
    },
  })
}
// 只写 dataDriven 子键、不动作者手填的 strategies/default；无足够数据(可用模型为空)则不动作，保留作者意图。
export async function recomputeRoutePolicy(payload: Payload, skillId: string): Promise<void> {
  const models = await aggregateByModel(payload, skillId)
  const ranked = rankDataDrivenRoute(
    models.map((m) => ({
      modelName: m.modelName,
      successRate: m.successRate,
      avgLatencyMs: m.avgLatencyMs,
      formatRate: m.formatRate,
      lowSample: m.lowSample,
    })),
  )
  if (!ranked.cheap.length && !ranked.fast.length && !ranked.quality.length) return // 无够样本可用模型，保留作者手填

  const skill = (await payload
    .findByID({ collection: 'skills', id: skillId, depth: 0, overrideAccess: true })
    .catch(() => null)) as any
  const versionId = skill && (typeof skill.currentVersion === 'object' ? skill.currentVersion?.id : skill.currentVersion)
  if (!versionId) return
  const version = (await payload
    .findByID({ collection: 'skill-versions', id: versionId, depth: 0, overrideAccess: true })
    .catch(() => null)) as any
  if (!version) return

  const rp = version.routePolicy && typeof version.routePolicy === 'object' ? { ...version.routePolicy } : {}
  rp.dataDriven = {
    cheap: ranked.cheap,
    fast: ranked.fast,
    quality: ranked.quality,
    recomputedAt: new Date().toISOString(),
  }
  await payload.update({
    collection: 'skill-versions',
    id: versionId,
    data: { routePolicy: rp },
    overrideAccess: true,
  })
}

// 按模型聚合（详情页展示用）
export interface ModelCompat {
  modelName: string
  reports: number
  verified: number
  successRate: number
  formatRate: number
  avgLatencyMs: number
  lowSample: boolean // 样本不足：前端应显示"战绩积累中"而非百分比
}
export async function aggregateByModel(payload: Payload, skillId: string): Promise<ModelCompat[]> {
  const res = await payload.find({
    collection: 'compat-reports',
    where: { skill: { equals: skillId } },
    limit: 5000,
    depth: 0,
    overrideAccess: true,
  })
  const now = Date.now()
  const byModel = new Map<string, any[]>()
  for (const r of res.docs as any[]) {
    const m = r.modelName || 'unknown'
    if (!byModel.has(m)) byModel.set(m, [])
    byModel.get(m)!.push(r)
  }
  const out: ModelCompat[] = []
  for (const [modelName, rs] of byModel) {
    let wSum = 0
    let wSuccess = 0
    let wFormat = 0
    let wLatency = 0
    let wLatencySum = 0
    for (const r of rs) {
      const w = r.suppressed ? 0 : decayWeight(r.createdAt, now) * sourceWeight(r.source)
      wSum += w
      if (r.success) wSuccess += w
      if (r.formatValid) wFormat += w
      if (typeof r.latencyMs === 'number') {
        wLatency += w * r.latencyMs
        wLatencySum += w
      }
    }
    out.push({
      modelName,
      reports: rs.length,
      verified: rs.filter((r) => r.source === 'verified').length,
      successRate: wSum > 0 ? wSuccess / wSum : 0,
      formatRate: wSum > 0 ? wFormat / wSum : 0,
      avgLatencyMs: wLatencySum > 0 ? Math.round(wLatency / wLatencySum) : 0,
      lowSample: rs.length < MIN_MODEL_SAMPLE,
    })
  }
  return out.sort((a, b) => b.reports - a.reports)
}

// 跨全站按模型聚合（中立模型榜用）：衰减×来源权重加权，返回逐模型全局实测事实。
export interface GlobalModelStat {
  model: string
  successRate: number
  formatRate: number
  avgLatencyMs: number
  samples: number
}
export async function aggregateModelsGlobal(payload: Payload): Promise<GlobalModelStat[]> {
  const now = Date.now()
  const byModel = new Map<
    string,
    { wSum: number; wSuccess: number; wFormat: number; wLat: number; wLatSum: number; n: number }
  >()
  let page = 1
  for (;;) {
    const res = await payload.find({
      collection: 'compat-reports',
      limit: 500,
      page,
      depth: 0,
      overrideAccess: true,
      sort: 'id',
    })
    for (const r of res.docs as any[]) {
      const m = r.modelName
      if (!m) continue
      const a = byModel.get(m) || { wSum: 0, wSuccess: 0, wFormat: 0, wLat: 0, wLatSum: 0, n: 0 }
      const w = r.suppressed ? 0 : decayWeight(r.createdAt, now) * sourceWeight(r.source)
      a.wSum += w
      if (r.success) a.wSuccess += w
      if (r.formatValid) a.wFormat += w
      if (typeof r.latencyMs === 'number') {
        a.wLat += w * r.latencyMs
        a.wLatSum += w
      }
      a.n++
      byModel.set(m, a)
    }
    if (!res.hasNextPage) break
    page++
  }
  const out: GlobalModelStat[] = []
  for (const [model, a] of byModel) {
    out.push({
      model,
      successRate: a.wSum > 0 ? a.wSuccess / a.wSum : 0,
      formatRate: a.wSum > 0 ? a.wFormat / a.wSum : 0,
      avgLatencyMs: a.wLatSum > 0 ? Math.round(a.wLat / a.wLatSum) : 0,
      samples: a.n,
    })
  }
  return out
}
