import { certificateVerifyPageUrl, evidenceVerifyApiUrl, evidenceVerifyPageUrl } from './evidenceLinks'

function relationSummary(value: any) {
  if (!value) return null
  if (typeof value === 'object') {
    return {
      id: String(value.id || ''),
      slug: value.slug || null,
      title: value.title || value.name || null,
      username: value.username || null,
      icon: value.icon || null,
    }
  }
  return {
    id: String(value),
    slug: null,
    title: null,
    username: null,
    icon: null,
  }
}

function passportSummary(passport: any, slug: string | null) {
  if (!passport) {
    return {
      status: 'missing',
      trustScore: null,
      trustedCompatibleRunCount: 0,
      evidenceHash: null,
      evidenceVerifyUrl: null,
      evidenceVerifyPageUrl: null,
      lastVerifiedAt: null,
      url: slug ? `/v1/skills/${encodeURIComponent(slug)}/passport` : null,
    }
  }
  const trustedCompatibleRunCount = Number(
    passport?.reliabilitySummary?.trustedCompatibleRunCount ??
      passport?.evidenceSummary?.trustedCompatibleRunCount ??
      0,
  )
  return {
    status: passport.status || null,
    skillClass: passport.skillClass || null,
    trustScore:
      typeof passport.trustScore === 'number'
        ? Math.round(passport.trustScore)
        : null,
    trustedCompatibleRunCount: Number.isFinite(trustedCompatibleRunCount)
      ? Math.max(0, Math.floor(trustedCompatibleRunCount))
      : 0,
    evidenceHash: passport.evidenceHash || null,
    evidenceVerifyUrl: evidenceVerifyApiUrl('skill_passport', passport?.id),
    evidenceVerifyPageUrl: evidenceVerifyPageUrl('skill_passport', passport?.id),
    lastVerifiedAt: passport.lastVerifiedAt || null,
    url: slug ? `/v1/skills/${encodeURIComponent(slug)}/passport` : null,
  }
}

export function publicSkillSummary(skill: any, passport?: any) {
  const slug = skill?.slug ? String(skill.slug) : null
  const passportInfo = passportSummary(passport, slug)
  return {
    id: String(skill?.id || ''),
    slug,
    title: skill?.title || null,
    description: skill?.description || null,
    category: relationSummary(skill?.category),
    author: relationSummary(skill?.author),
    status: skill?.status || null,
    visibility: skill?.visibility || null,
    isEssential: Boolean(skill?.isEssential),
    essentialReason: skill?.essentialReason || null,
    isFeatured: Boolean(skill?.isFeatured),
    skillRank: Math.round(Number(skill?.skillRank || 0)),
    localScore: Math.round(Number(skill?.localScore || 0)),
    successRate: skill?.successRate ?? null,
    trustedCompatibleRunCount: passportInfo.trustedCompatibleRunCount,
    avgCost: skill?.avgCost ?? null,
    avgLatencyMs: skill?.avgLatencyMs ?? null,
    favoriteCount: skill?.favoriteCount || 0,
    detailUrl: slug ? `/skills/${encodeURIComponent(slug)}` : null,
    runUrl: slug ? `/skills/${encodeURIComponent(slug)}/run` : null,
    runLedgerUrl: skill?.id ? `/console/runs?skillId=${encodeURIComponent(String(skill.id))}` : null,
    passport: passportInfo,
    passportUrl: slug
      ? `/v1/skills/${encodeURIComponent(slug)}/passport`
      : null,
    certificateUrl: slug
      ? `/v1/skills/${encodeURIComponent(slug)}/certificate`
      : null,
    certificateVerifyPageUrl: slug
      ? certificateVerifyPageUrl(`/v1/skills/${encodeURIComponent(slug)}/certificate`)
      : null,
    evidenceVerifyUrl: passportInfo.evidenceVerifyUrl,
    evidenceVerifyPageUrl: passportInfo.evidenceVerifyPageUrl,
    updatedAt: skill?.updatedAt || null,
  }
}
