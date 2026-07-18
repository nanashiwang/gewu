const secret = String(process.env.RELAY_CRON_SECRET || '')
const target = String(process.env.RELAY_CRON_URL || 'http://app:3000/v1/internal/relay-checks/run')
const configuredIntervalMs = Number(process.env.RELAY_CRON_INTERVAL_MS || 60_000)
const intervalMs = Number.isFinite(configuredIntervalMs)
  ? Math.min(24 * 60 * 60 * 1000, Math.max(30_000, configuredIntervalMs))
  : 60_000

if (secret.length < 24) {
  console.error('RELAY_CRON_SECRET 必须配置为至少 24 位随机值')
  process.exit(1)
}

let stopping = false
async function tick() {
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(Math.min(intervalMs - 1000, 50_000)),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
    console.log(`[relay-cron] ${new Date().toISOString()} ${text.slice(0, 500)}`)
  } catch (error) {
    console.error(`[relay-cron] ${new Date().toISOString()} ${(error && error.message) || error}`)
  }
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

while (!stopping) {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
}
