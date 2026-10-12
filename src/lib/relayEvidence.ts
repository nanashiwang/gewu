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
  const version = report.scoring_version || 'weighted-v1'
  if (!['weighted-v1', 'evidence-v2'].includes(version)) return false
  const core = protocol === 'anthropic' ? 'identity' : ['openai', 'gemini'].includes(protocol) ? 'basic_request' : null
  if (!core || !Array.isArray(report.results) || report.results.length === 0) return false
  if (report.results.some((row: any) => !row || row.error || !['pass', 'fail', 'skip'].includes(row.status) || hasAuthFailure(row.details))) return false
  if (version === 'evidence-v2') {
    if (typeof report.probe_version !== 'string' || !report.probe_version.trim()) return false
    const names = report.results.map((row: any) => row.name)
    if (names.some((name: any) => typeof name !== 'string' || !name) || new Set(names).size !== names.length) return false
    const observation = (row: any) => protocol === 'anthropic' && ['identity', 'behavioral_signature', 'knowledge'].includes(row.name)
    if (report.results.some((row: any) => observation(row) ? row.evidence_role !== 'observation' || row.weight !== 0 : (row.evidence_role || 'scored') !== 'scored')) return false
    if (report.results.some((row: any) => !Number.isFinite(row.score) || row.score < 0 || row.score > 100 || !Number.isFinite(row.weight) || row.weight < 0)) return false
    const scored = report.results.filter((row: any) => !observation(row) && row.status !== 'skip' && row.weight > 0)
    const weight = scored.reduce((sum: number, row: any) => sum + row.weight, 0)
    if (!weight || !Number.isFinite(report.total_score) || Math.abs(scored.reduce((sum: number, row: any) => sum + row.score * row.weight, 0) / weight - report.total_score) > 0.01) return false
    if (protocol === 'anthropic' && !report.results.some((row: any) => row.name === core && row.details?.core_response_valid === true && ['pass', 'fail'].includes(row.status))) return false
  }
  return report.results.some((row: any) => row.name === core && ['pass', 'fail'].includes(row.status))
}
