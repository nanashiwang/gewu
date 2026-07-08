export type RunnerInstallPlaybookInput = {
  slug?: string | null
  version?: string | null
  checksum?: string | null
  signed?: boolean | null
}

export function runnerInstallPlaybook(input: RunnerInstallPlaybookInput = {}) {
  const slug = input.slug ? String(input.slug) : ''
  const version = input.version ? String(input.version) : ''
  const checksum = input.checksum ? String(input.checksum) : ''
  const signed = input.signed !== false

  return {
    customerValue:
      '把 Skill 从下载安装到本地可信运行闭环：先验签 manifest，再绑定自有模型或网关，最后只回传脱敏兼容指标。',
    decision: signed ? 'install_and_report' : 'verify_before_install',
    installScope: {
      slug: slug || null,
      version: version || null,
      checksum: checksum || null,
      requiresSignedManifest: true,
    },
    nextActions: [
      {
        label: '校验 manifest',
        description: signed
          ? 'Runner 会校验 checksum 与 ed25519 签名；远端 manifest 未签名或签名无效时默认拒绝安装。'
          : '当前 manifest 未确认签名状态；生产安装前应获取 /v1/keys 公钥并完成 checksum 与 ed25519 验签。',
        href: '/v1/keys',
      },
      {
        label: '本地运行',
        description: '用本地 Ollama/LM Studio/vLLM，或传入 OpenAI 兼容 endpoint 与自己的 API Key；任务输入不必经过平台。',
        href: slug ? `/v1/skills/${encodeURIComponent(slug)}/manifest` : null,
      },
      {
        label: '回传兼容报告',
        description: '仅在当前 Runner 已安装且 checksum 匹配时回传成功率、格式、延迟、错误类型等脱敏指标，不回传输入/输出原文。',
        href: '/v1/runner/report',
      },
      {
        label: '保持版本新鲜',
        description: '若 Skill 当前版本或 checksum 变化，先执行 outdated/update；过期安装提交报告会被拒绝，避免污染兼容证据。',
        href: '/v1/runner/check',
      },
    ],
  }
}
