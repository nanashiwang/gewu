export type RunnerUpdateItem = {
  slug?: string | null
  available?: boolean | null
  outdated?: boolean | null
  version?: string | null
  checksum?: string | null
}

export function runnerUpdatePlaybook(items: RunnerUpdateItem[] = []) {
  const available = items.filter((item) => item.available !== false)
  const outdated = available.filter((item) => item.outdated)
  const missing = items.filter((item) => item.available === false)

  return {
    customerValue:
      '把本地安装保持在可回流状态：先发现过期 checksum，更新并重新验签，再运行 --report，避免旧版本污染兼容证据。',
    decision: outdated.length > 0 ? 'update_before_report' : missing.length > 0 ? 'review_missing' : 'current',
    summary: {
      checked: items.length,
      available: available.length,
      outdated: outdated.length,
      missing: missing.length,
    },
    nextActions: [
      {
        label: outdated.length > 0 ? '先更新过期 Skill' : '保持当前版本',
        description:
          outdated.length > 0
            ? '这些本地安装的 checksum 已落后；先执行 gewu update，再提交兼容报告。'
            : '当前 checksum 与 Hub 一致，可以继续本地运行或回传脱敏兼容报告。',
        slugs: outdated.map((item) => item.slug).filter(Boolean),
      },
      {
        label: '重新验签 manifest',
        description: 'update 会重新下载冻结 manifest，并校验 checksum 与 ed25519 签名；未签名/签名无效默认拒绝安装。',
        href: '/v1/keys',
      },
      {
        label: '回流前复验',
        description: '更新后用同一输入重新运行；只有 active install 与当前 checksum 匹配的报告才会被 Hub 接收。',
        href: '/v1/runner/report',
      },
      {
        label: '处理不可用项',
        description:
          missing.length > 0
            ? '部分 slug 已不可安装，建议从本地移除或回到 Skill 市场选择替代项。'
            : '没有发现不可用 Skill。',
        slugs: missing.map((item) => item.slug).filter(Boolean),
      },
    ],
  }
}
