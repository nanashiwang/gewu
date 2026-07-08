import { certificateVerifyPageUrl, evidenceVerifyApiUrl, evidenceVerifyPageUrl } from './evidenceLinks'
import { publicSkillRankBasis, publicSkillRankExplanation } from './skillrank'

export type StarterPackOverride = {
  reason?: string | null
  starterExample?: unknown
  order?: number
}

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

function starterPlaybook(skill: any, passportInfo: any) {
  const slug = skill?.slug ? String(skill.slug) : ''
  const skillId = skill?.id ? String(skill.id) : ''
  const isEssential = Boolean(skill?.isEssential)
  const hasCurrentPassport = passportInfo?.status === 'current'
  const starterExampleConfigured = skill?.starterExample !== undefined && skill?.starterExample !== null
  const decision = isEssential
    ? 'start_here'
    : hasCurrentPassport
      ? 'try_with_evidence'
      : 'review_first'

  return {
    customerValue:
      '让新用户快速尝到甜头：先选有推荐理由和 Passport 证据的 Skill，用默认输入试跑，再回私人台账看结果并换模型重跑。',
    decision,
    nextActions: [
      {
        label: isEssential ? '先跑必备 Skill' : '先看适用场景',
        description: isEssential
          ? skill?.essentialReason || '这是适合新手第一跑的 Skill，先用默认输入验证效果。'
          : '先确认该 Skill 是否覆盖你的任务，再决定是否试跑或收藏。',
        href: slug ? `/skills/${encodeURIComponent(slug)}` : null,
      },
      {
        label: '看 Passport',
        description: hasCurrentPassport
          ? '已有当前 Passport，可先看可信分、兼容证据、失败摘要和验签入口。'
          : 'Passport 尚未达到当前状态，试跑前应降低信任预期。',
        href: passportInfo?.url || null,
      },
      {
        label: '默认输入试跑',
        description: starterExampleConfigured
          ? '后台已配置公开默认示例，可直接试跑并把结果沉淀到你的私人运行台账。'
          : '用在线试跑或本地 Runner 跑一次，把结果沉淀到你的私人运行台账。',
        href: slug ? `/skills/${encodeURIComponent(slug)}/run` : null,
      },
      {
        label: '回台账重跑',
        description: '如果结果有用，用同一输入换模型重跑，比较成功率、格式、成本和延迟。',
        href: skillId ? `/console/runs?skillId=${encodeURIComponent(skillId)}` : '/console/runs',
      },
    ],
  }
}

export function publicSkillSummary(skill: any, passport?: any, starterOverride?: StarterPackOverride | null) {
  const starterSkill = starterOverride
    ? {
        ...skill,
        isEssential: true,
        essentialReason: starterOverride.reason || skill?.essentialReason,
        starterExample: starterOverride.starterExample,
      }
    : skill
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
    isEssential: Boolean(starterSkill?.isEssential),
    essentialReason: starterSkill?.essentialReason || null,
    starterPackOrder: starterOverride?.order ?? null,
    starterExample: starterOverride?.starterExample ?? null,
    isFeatured: Boolean(skill?.isFeatured),
    skillRank: Math.round(Number(skill?.skillRank || 0)),
    rankBasis: publicSkillRankBasis(skill, passport),
    rankExplanation: publicSkillRankExplanation(skill, passport),
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
    starterPlaybook: starterPlaybook(starterSkill, passportInfo),
    updatedAt: skill?.updatedAt || null,
  }
}
