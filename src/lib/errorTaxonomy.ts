// 运行错误受控分类（总纲 6m，负知识库原料）。两层：infra=基础设施级、capability=模型能力级。
// 分类只产出标签（不存原文），与"compat 报告不含输入输出"的隐私承诺一致。

export const ERROR_TAXONOMY = {
  infra: ['network', 'timeout', 'rate_limit', 'auth', 'http_4xx', 'http_5xx', 'unknown_infra'],
  capability: ['empty_output', 'json_invalid', 'format_drift'],
} as const

export type ErrorType =
  | (typeof ERROR_TAXONOMY.infra)[number]
  | (typeof ERROR_TAXONOMY.capability)[number]

// 从失败信息/输出校验结果归一化为错误类型。成功且格式有效 → undefined（无错）。
export function classifyError(opts: {
  hasResult: boolean // 是否拿到模型响应（false=调用失败）
  lastError?: string
  formatValid: boolean
  outputSchemaPresent: boolean // 该 Skill 是否声明了 outputSchema（无 schema 则不判格式）
  text?: string
}): ErrorType | undefined {
  // 调用失败：从错误串匹配基础设施级原因
  if (!opts.hasResult) {
    const e = (opts.lastError || '').toLowerCase()
    if (/time?out|etimedout|timed out|abort/.test(e)) return 'timeout'
    if (/rate.?limit|429|too many/.test(e)) return 'rate_limit'
    if (/401|403|unauthor|invalid api key|invalid key|forbidden/.test(e)) return 'auth'
    if (/\b5\d\d\b|internal server|bad gateway|unavailable/.test(e)) return 'http_5xx'
    if (/\b4\d\d\b|bad request/.test(e)) return 'http_4xx'
    if (/network|econnrefused|enotfound|econnreset|fetch failed|socket/.test(e)) return 'network'
    return 'unknown_infra'
  }
  // 拿到响应但能力层问题
  if (!opts.text || opts.text.trim().length === 0) return 'empty_output'
  if (opts.outputSchemaPresent && !opts.formatValid) {
    // 有 schema 但校验不过：能解析出 JSON 但字段不符=format_drift，完全非 JSON=json_invalid
    const looksJson = /[{[]/.test(opts.text)
    return looksJson ? 'format_drift' : 'json_invalid'
  }
  return undefined
}
