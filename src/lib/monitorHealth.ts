export type MonitorTarget = {
  target_id: string; protocol: string; model: string; mode: string; label: string; failure_kind: string
  consecutive_failures: number; last_attempt_at: string; last_valid_at: string | null
  next_attempt_at: string | null; last_report_id: string | null; cooling: boolean
}
export type MonitorHealth = { available: boolean; targets: MonitorTarget[]; summary: { history_limited?: boolean } }

// Used by the authenticated staff page only. The internal credential must
// never reach a browser or be forwarded through an upstream redirect.
export async function getMonitorHealth(): Promise<MonitorHealth> {
  const unavailable: MonitorHealth = { available: false, targets: [], summary: {} }
  const token = process.env.GEWU_INTERNAL_API_TOKEN?.trim()
  if (!token) return unavailable
  try {
    const base = new URL(process.env.DETECTOR_BASE_URL?.trim() || 'http://127.0.0.1:8765')
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return unavailable
    const response = await fetch(`${base.toString().replace(/\/+$/, '')}/api/status/monitor-health/summary`, {
      headers: { 'X-Gewu-Internal-Token': token }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) return unavailable
    const data = await response.json()
    if (data?.available !== true || !Array.isArray(data.targets) || data.targets.length > 1000) return unavailable
    if (!data.targets.every((row: any) => row &&
      ['target_id', 'protocol', 'model', 'mode', 'label', 'failure_kind', 'last_attempt_at'].every(key => typeof row[key] === 'string') &&
      Number.isSafeInteger(row.consecutive_failures) && row.consecutive_failures >= 0 &&
      ['last_valid_at', 'next_attempt_at', 'last_report_id'].every(key => row[key] === null || typeof row[key] === 'string') &&
      typeof row.cooling === 'boolean')) return unavailable
    return { available: true, targets: data.targets, summary: { history_limited: data.summary?.history_limited === true } }
  } catch {
    return unavailable
  }
}
