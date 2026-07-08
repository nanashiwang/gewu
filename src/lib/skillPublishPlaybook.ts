export type SkillPublishPlaybookInput = {
  slug?: string | null
  status?: string | null
  reviewDecision?: string | null
  autoPublished?: boolean
}

export function skillPublishPlaybook(input: SkillPublishPlaybookInput) {
  const slug = input.slug ? String(input.slug) : ''
  const published = input.autoPublished || input.status === 'published'
  const rejected = input.reviewDecision === 'reject'
  const decision = published ? 'maintain' : rejected ? 'revise' : 'review'
  return {
    customerValue:
      '把一次 Prompt/Skill 发布变成可维护资产：先固化 Contract，再刷新 Passport 和证书，后续用失败库与 Adapter 持续适配模型。',
    decision,
    nextActions: [
      {
        label: '核对 Contract',
        description: '确认输入/输出 schema、权限、推荐模型和版本边界，避免后续变更无法追踪。',
        href: slug ? `/v1/skills/${encodeURIComponent(slug)}/contract` : null,
      },
      {
        label: '刷新 Passport',
        description: published
          ? '已发布 Skill 会把身份、签名、兼容、失败和证据状态沉淀为当前 Passport。'
          : '待审阶段只作为作者预览，审核发布后才会成为正式公开证据。',
        href: slug ? `/v1/skills/${encodeURIComponent(slug)}/passport` : null,
      },
      {
        label: '验签证书',
        description: '证书绑定 Contract、Passport 和黄金样例；未达 passed 时先按原因补齐证据。',
        href: slug
          ? `/verify?certificateUrl=${encodeURIComponent(`/v1/skills/${encodeURIComponent(slug)}/certificate`)}`
          : null,
      },
      {
        label: '用失败库维护',
        description: '上线后真实失败会进入 FailureCase，作者可生成 Adapter 草稿并复验 lift。',
        href: slug ? `/failures?skill=${encodeURIComponent(slug)}` : '/failures',
      },
    ],
  }
}
