import type { Payload } from 'payload'
import { createHmac } from 'crypto'

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

// 由兼容报告聚合重算 Skill 的 LocalScore（0-100）并写回
export async function recomputeLocalScore(payload: Payload, skillId: string) {
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
    const successRate = reports.filter((r) => r.success).length / reports.length
    const formatRate = reports.filter((r) => r.formatValid).length / reports.length
    const distinctModels = new Set(reports.map((r) => r.modelName)).size
    const coverage = Math.min(1, distinctModels / 3)
    localScore = Math.round(100 * (0.6 * successRate + 0.3 * formatRate + 0.1 * coverage))
  }
  await payload.update({
    collection: 'skills',
    id: skillId,
    data: { localScore },
    overrideAccess: true,
  })
  return localScore
}

// 按模型聚合（详情页展示用）
export interface ModelCompat {
  modelName: string
  reports: number
  verified: number
  successRate: number
  formatRate: number
  avgLatencyMs: number
}
export async function aggregateByModel(payload: Payload, skillId: string): Promise<ModelCompat[]> {
  const res = await payload.find({
    collection: 'compat-reports',
    where: { skill: { equals: skillId } },
    limit: 5000,
    depth: 0,
    overrideAccess: true,
  })
  const byModel = new Map<string, any[]>()
  for (const r of res.docs as any[]) {
    const m = r.modelName || 'unknown'
    if (!byModel.has(m)) byModel.set(m, [])
    byModel.get(m)!.push(r)
  }
  const out: ModelCompat[] = []
  for (const [modelName, rs] of byModel) {
    const n = rs.length
    out.push({
      modelName,
      reports: n,
      verified: rs.filter((r) => r.source === 'verified').length,
      successRate: rs.filter((r) => r.success).length / n,
      formatRate: rs.filter((r) => r.formatValid).length / n,
      avgLatencyMs: Math.round(rs.reduce((a, r) => a + (r.latencyMs || 0), 0) / n),
    })
  }
  return out.sort((a, b) => b.reports - a.reports)
}
