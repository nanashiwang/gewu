export const RELAY_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  suspended: '已暂停',
}

export const RELAY_CLAIM_LABELS: Record<string, string> = {
  unverified: '未验证',
  pending: '待验证',
  verified: '已验证',
  failed: '验证失败',
  manual: '人工验证',
}

export const RELAY_PROTOCOL_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude / Anthropic',
  gemini: 'Gemini',
}

export const RELAY_CONTACT_LABELS: Record<string, string> = {
  email: '邮箱',
  qq: 'QQ',
  wechat: '微信',
  telegram: 'Telegram',
  discord: 'Discord',
  other: '其他',
}

export function relayStatusClass(status: string): string {
  if (status === 'approved' || status === 'verified' || status === 'manual') return 'text-[var(--accent-2)]'
  if (status === 'pending' || status === 'unverified') return 'text-[var(--warn)]'
  if (status === 'rejected' || status === 'suspended' || status === 'failed') return 'text-[var(--danger)]'
  return 'text-[var(--muted)]'
}
