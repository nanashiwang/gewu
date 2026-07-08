import { publicSanitize } from './publicSanitize'
import { boundedStringParam } from './queryParams'

export function buildModelProfileWhere(params: URLSearchParams) {
  const modelName = boundedStringParam(params, 'modelName', 160)
  const modelVersion = boundedStringParam(params, 'modelVersion', 160)
  const provider = boundedStringParam(params, 'provider', 80)
  const profileStatus = params.get('status')?.trim()
  const and: any[] = [
    profileStatus && ['observed', 'verified', 'stale'].includes(profileStatus)
      ? { profileStatus: { equals: profileStatus } }
      : { profileStatus: { in: ['observed', 'verified', 'stale'] } },
    {
      or: [
        { 'capabilities.observedSamples': { greater_than: 0 } },
        { 'capabilities.effectiveSamples': { greater_than: 0 } },
      ],
    },
  ]
  if (modelName) and.push({ modelName: { equals: modelName } })
  if (modelVersion) and.push({ modelVersion: { equals: modelVersion } })
  if (provider) and.push({ provider: { equals: provider } })
  return { and }
}

export function isPublicModelProfile(profile: any) {
  const status = String(profile?.profileStatus || 'observed')
  const capabilities = profile?.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities : {}
  const observedSamples = Number(capabilities.observedSamples || 0)
  const effectiveSamples = Number(capabilities.effectiveSamples || 0)
  return ['observed', 'verified', 'stale'].includes(status) && (observedSamples > 0 || effectiveSamples > 0)
}

function modelProfilePlaybook(profile: any) {
  const modelParams = profile?.modelName
    ? new URLSearchParams({
        modelName: String(profile.modelName),
        ...(profile?.modelVersion ? { modelVersion: String(profile.modelVersion) } : {}),
      }).toString()
    : ''
  const alerts = Array.isArray(profile?.regressionAlerts) ? profile.regressionAlerts : []
  const driftSummary =
    profile?.driftSummary && typeof profile.driftSummary === 'object' ? profile.driftSummary : {}
  const capabilities =
    profile?.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities : {}
  const effectiveSamples = Number(capabilities.effectiveSamples ?? capabilities.observedSamples ?? 0)
  const decision = alerts.some((alert: any) => alert?.severity === 'critical')
    ? 'avoid'
    : alerts.length > 0 || profile?.profileStatus === 'stale'
      ? 'review'
      : effectiveSamples >= 5 && driftSummary.status === 'stable'
        ? 'use'
        : 'trial'
  return {
    customerValue:
      '把模型画像从“排行榜名次”变成可执行判断：看版本、有效样本、漂移、回归告警，再决定试跑、锁版本、换模型或查失败库。',
    decision,
    nextActions: [
      {
        label: '确认模型版本',
        description: profile?.modelVersion
          ? `当前画像绑定版本 ${profile.modelVersion}，优先用同版本复核。`
          : '缺少明确模型版本，只适合作为粗略参考。',
      },
      {
        label: '看有效样本和来源',
        description: `有效样本 ${Number.isFinite(effectiveSamples) ? effectiveSamples : 0}；样本少时先试跑，不要直接采购或大规模替换。`,
      },
      {
        label: '处理漂移/回归',
        description: alerts.length
          ? '存在回归告警，建议锁旧版本、换模型或等待 Adapter 修复。'
          : driftSummary.status === 'stable'
            ? '漂移摘要稳定，可继续观察真实任务回流。'
            : '漂移证据不足，建议用你的 Skill 再跑一次。',
      },
      {
        label: '查失败库/Adapter',
        description: '查看该模型是否有已知失败模式或可复用 Adapter。',
        href: modelParams ? `/failures?${modelParams}` : null,
      },
    ],
  }
}

export function publicModelProfile(profile: any) {
  const capabilities = publicSanitize(profile?.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities : {})
  const knownIssues = publicSanitize(profile?.knownIssues && typeof profile.knownIssues === 'object' ? profile.knownIssues : {})
  const modelParams = profile?.modelName
    ? new URLSearchParams({
        modelName: String(profile.modelName),
        ...(profile?.modelVersion ? { modelVersion: String(profile.modelVersion) } : {}),
      }).toString()
    : ''
  return {
    id: String(profile?.id || ''),
    provider: profile?.provider || null,
    modelName: profile?.modelName || null,
    failuresUrl: modelParams ? `/failures?${modelParams}` : null,
    adaptersUrl: modelParams ? `/v1/adapters?${modelParams}` : null,
    modelVersion: profile?.modelVersion || null,
    profileStatus: profile?.profileStatus || 'observed',
    supportsStructuredOutput: Boolean(profile?.supportsStructuredOutput),
    supportsToolUse: Boolean(profile?.supportsToolUse),
    jsonStabilityScore: profile?.jsonStabilityScore ?? null,
    contextLength: profile?.contextLength ?? null,
    region: profile?.region || null,
    knownIssues: {
      lowSamples: Boolean(knownIssues.lowSamples),
      successRate: knownIssues.successRate ?? null,
      formatRate: knownIssues.formatRate ?? null,
      avgLatencyMs: knownIssues.avgLatencyMs ?? null,
    },
    capabilities: {
      observedSamples: capabilities.observedSamples ?? 0,
      effectiveSamples: capabilities.effectiveSamples ?? capabilities.observedSamples ?? 0,
      sourceSummary: Array.isArray(capabilities.sourceSummary) ? capabilities.sourceSummary : [],
    },
    regressionAlerts: publicSanitize(Array.isArray(profile?.regressionAlerts) ? profile.regressionAlerts : []),
    driftSummary: publicSanitize(profile?.driftSummary && typeof profile.driftSummary === 'object' ? profile.driftSummary : null),
    driftHistory: publicSanitize(Array.isArray(profile?.driftHistory) ? profile.driftHistory : []),
    freshness: publicSanitize(profile?.freshness && typeof profile.freshness === 'object' ? profile.freshness : null),
    playbook: publicSanitize(modelProfilePlaybook(profile)),
    lastObservedAt: profile?.lastObservedAt || null,
  }
}
