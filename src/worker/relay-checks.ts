import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'
import { runRelayCheckCycle } from '../lib/relayDetection'

async function main() {
  const payload = await getPayload({ config })
  const result = await runRelayCheckCycle(payload)
  payload.logger.info(`中转检测周期完成：对账 ${result.reconciled}，新提交 ${result.submitted}，失败 ${result.failed}`)
  process.exit(result.failed > 0 ? 2 : 0)
}

main().catch((error) => {
  console.error('中转检测 worker 失败：', error)
  process.exit(1)
})
