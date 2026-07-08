import type { Payload } from 'payload'
import { runSkill, type RunSkillResult } from './skillRunner'
import { decryptSecret } from './secrets'
import { canRerunPrivateLedgerSkill } from './skillEvidenceAccess'
import { isUsableSkillVersionForPublicEvidence, resolveCurrentSkillVersionForPublicEvidence } from './skillVersionPublic'
import type { ReverifyJob } from './reverifyQueue'

export interface ReverifyRunOutcome {
  sourceRunId: string
  newRunId?: string
  ok: boolean
  formatValid?: boolean
  errorCode?: string
  skipped?: string
}

export interface ReverifyJobResult {
  failureCaseId: string
  attempted: number
  succeeded: number
  formatValid: number
  skipped: number
  outcomes: ReverifyRunOutcome[]
}

function relationId(value: any): string | null {
  if (!value) return null
  if (typeof value === 'object') return value.id ? String(value.id) : null
  return String(value)
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function mergeReverifyCoverage(
  current: unknown,
  result: Pick<ReverifyJobResult, 'attempted' | 'succeeded' | 'formatValid' | 'outcomes'>,
  meta: { job?: ReverifyJob; now?: string } = {},
) {
  const coverage = asObject(current)
  const previousVerified = safeNumber(coverage.verifiedRuns)
  const targetRuns = Math.max(1, safeNumber(coverage.targetRuns, 3) || 3)
  const previousSuccesses = Math.round(safeNumber(coverage.afterSuccessRate) * previousVerified)
  const previousFormatValid = Math.round(safeNumber(coverage.formatRateAfter) * previousVerified)
  const attempted = Math.max(0, result.attempted)
  const verifiedRuns = previousVerified + attempted
  const successCount = previousSuccesses + Math.max(0, result.succeeded)
  const formatValidCount = previousFormatValid + Math.max(0, result.formatValid)
  const lastOutcomes = result.outcomes.slice(0, 20).map((o) => ({
    sourceRunId: o.sourceRunId,
    newRunId: o.newRunId || null,
    ok: o.ok,
    formatValid: o.formatValid ?? null,
    errorCode: o.errorCode || null,
    skipped: o.skipped || null,
  }))

  return {
    ...coverage,
    targetRuns,
    verifiedRuns,
    afterSuccessRate: verifiedRuns > 0 ? successCount / verifiedRuns : null,
    formatRateAfter: verifiedRuns > 0 ? formatValidCount / verifiedRuns : null,
    lastReverifiedAt: meta.now || new Date().toISOString(),
    lastReverifyJob: meta.job
      ? {
          failureCaseId: meta.job.failureCaseId,
          userId: meta.job.userId,
          candidateRunIds: meta.job.candidateRunIds,
          adapterIds: meta.job.adapterIds,
          reason: meta.job.reason,
          enqueuedAt: meta.job.enqueuedAt,
        }
      : null,
    lastReverifyOutcomes: lastOutcomes,
  }
}

async function loadVersionForRun(payload: Payload, skill: any, run: any) {
  const versionId = relationId(run?.skillVersion)
  if (versionId) {
    const version = await payload.findByID({ collection: 'skill-versions' as any, id: versionId, overrideAccess: true }).catch(() => null)
    if (version) return version
  }
  return resolveCurrentSkillVersionForPublicEvidence(payload, skill)
}

async function rerunCandidate(payload: Payload, args: { failureCase: any; user: any; sourceRunId: string }): Promise<ReverifyRunOutcome> {
  const { failureCase, user, sourceRunId } = args
  const run = await payload.findByID({ collection: 'skill-runs' as any, id: sourceRunId, depth: 0, overrideAccess: true }).catch(() => null) as any
  if (!run) return { sourceRunId, ok: false, skipped: 'source_run_missing' }
  if (String(relationId(run.user)) !== String(user.id)) return { sourceRunId, ok: false, skipped: 'source_run_not_owned_by_user' }

  const failureSkillId = relationId(failureCase?.skill)
  const runSkillId = relationId(run.skill)
  if (failureSkillId && runSkillId && failureSkillId !== runSkillId) return { sourceRunId, ok: false, skipped: 'skill_mismatch' }

  const skill = runSkillId
    ? await payload.findByID({ collection: 'skills' as any, id: runSkillId, depth: 1, overrideAccess: true }).catch(() => null)
    : null
  if (!skill) return { sourceRunId, ok: false, skipped: 'skill_missing' }
  if (!canRerunPrivateLedgerSkill(skill, user)) return { sourceRunId, ok: false, skipped: 'skill_not_rerunnable' }

  const version = await loadVersionForRun(payload, skill, run)
  if (!version) return { sourceRunId, ok: false, skipped: 'version_missing' }
  if (!isUsableSkillVersionForPublicEvidence(skill, version)) return { sourceRunId, ok: false, skipped: 'version_not_usable' }

  const input = asObject(run.inputJson)
  const userApiKey = decryptSecret(user?.newapiKeyEncrypted) || undefined
  const forceModel = String(failureCase?.modelName || run.model || '').trim() || undefined
  const modelVersion = String(failureCase?.primaryModelVersion || run.modelVersion || '').trim() || undefined

  const result: RunSkillResult = await runSkill({
    payload,
    skill,
    version,
    input,
    user: { id: String(user.id) },
    userApiKey,
    forceModel,
    modelVersion,
    rerunOf: String(run.id),
    rerunFromModel: run.model ? String(run.model) : undefined,
  })

  return {
    sourceRunId,
    newRunId: result.skillRunId,
    ok: Boolean(result.ok),
    formatValid: Boolean(result.formatValid),
    errorCode: result.errorCode,
  }
}

export async function processReverifyJob(payload: Payload, job: ReverifyJob, opts: { maxRuns?: number; now?: string } = {}): Promise<ReverifyJobResult> {
  const failureCase = await payload.findByID({ collection: 'failure-cases' as any, id: job.failureCaseId, depth: 1, overrideAccess: true }).catch(() => null) as any
  if (!failureCase) throw new Error(`failure case not found: ${job.failureCaseId}`)

  const user = await payload.findByID({ collection: 'users' as any, id: job.userId, depth: 0, overrideAccess: true }).catch(() => null) as any
  if (!user || user.accountStatus === 'banned') throw new Error(`user not runnable: ${job.userId}`)

  const limit = Math.max(1, opts.maxRuns || 5)
  const candidateRunIds = [...new Set(job.candidateRunIds)].slice(0, limit)
  const outcomes: ReverifyRunOutcome[] = []
  for (const sourceRunId of candidateRunIds) {
    try {
      outcomes.push(await rerunCandidate(payload, { failureCase, user, sourceRunId }))
    } catch (e) {
      outcomes.push({ sourceRunId, ok: false, errorCode: (e as Error).message })
    }
  }

  const attemptedOutcomes = outcomes.filter((o) => !o.skipped)
  const result: ReverifyJobResult = {
    failureCaseId: job.failureCaseId,
    attempted: attemptedOutcomes.length,
    succeeded: attemptedOutcomes.filter((o) => o.ok).length,
    formatValid: attemptedOutcomes.filter((o) => o.formatValid).length,
    skipped: outcomes.length - attemptedOutcomes.length,
    outcomes,
  }

  if (result.attempted > 0) {
    const coverage = mergeReverifyCoverage(failureCase.verificationCoverage, result, { job, now: opts.now })
    const nextData: Record<string, unknown> = { verificationCoverage: coverage }
    if (safeNumber((coverage as any).verifiedRuns) >= safeNumber((coverage as any).targetRuns, 3)) nextData.triageStatus = 'verified'
    await payload.update({ collection: 'failure-cases' as any, id: job.failureCaseId, data: nextData, overrideAccess: true })
  }

  return result
}
