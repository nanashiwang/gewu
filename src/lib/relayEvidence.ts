// Match the detector's transport-error check for historical reports that lack assessment.
// Deliberately exclude response_text and other model-authored content.
const authFailure = /\b(?:401|403)\b|authentication[_ -]?error|unauthori[sz]ed|(?:invalid|incorrect).{0,24}api.{0,8}key|bad key|鉴权|认证失败|无效.{0,12}(?:密钥|key)/i
const transportFields = new Set(['error', 'error_message', 'message', 'response_body', 'status', 'status_code'])
function hasAuthFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasAuthFailure)
  return Object.entries(value).some(([key, child]) => {
    if (transportFields.has(key.toLowerCase()) && (typeof child === 'string' || typeof child === 'number')) return authFailure.test(String(child))
    return hasAuthFailure(child)
  })
}

/** Fail closed when a detector run did not collect enough evidence to score. */
export function reportHasUsableEvidence(report: any, protocol: string): boolean {
  if (!report || report.run_error || report.assessment?.score_usable === false) return false
  const core = protocol === 'anthropic' ? 'identity' : ['openai', 'gemini'].includes(protocol) ? 'basic_request' : null
  if (!core || !Array.isArray(report.results) || report.results.length === 0) return false
  if (report.results.some((row: any) => !row || row.error || !['pass', 'fail', 'skip'].includes(row.status) || hasAuthFailure(row.details))) return false
  return report.results.some((row: any) => row.name === core && ['pass', 'fail'].includes(row.status))
}
