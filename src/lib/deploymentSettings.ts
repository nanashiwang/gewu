import type { Payload } from 'payload'
import { decryptSecret, encryptSecret } from './secrets'

export type RuntimeEnv = Record<string, string | undefined>

const SECRET_FIELDS = [
  'modelGatewayKeyEncrypted',
  'newapiAdminKeyEncrypted',
  'signingKeyEncrypted',
] as const

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function put(out: RuntimeEnv, key: string, value: unknown) {
  const v = str(value)
  if (v) out[key] = v
}

function putNumber(out: RuntimeEnv, key: string, value: unknown) {
  if (value == null || value === '') return
  const n = Number(value)
  if (Number.isFinite(n)) out[key] = String(n)
}

function putBoolFlag(out: RuntimeEnv, key: string, value: unknown) {
  if (value === true) out[key] = '1'
  else if (typeof value === 'boolean') out[key] = ''
}

function putSecret(out: RuntimeEnv, key: string, encrypted: unknown) {
  const plain = decryptSecret(str(encrypted))
  if (plain) out[key] = plain
}

export function normalizeDeploymentSecretFields<T extends Record<string, unknown> | undefined>(data: T): T {
  if (!data) return data
  for (const field of SECRET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue
    const raw = str(data[field])
    data[field] = raw ? encryptSecret(raw) : null
  }
  return data
}

export function deploymentSettingsToEnv(doc: any, base: RuntimeEnv = process.env): RuntimeEnv {
  const out: RuntimeEnv = { ...base }
  if (!doc || typeof doc !== 'object') return out

  put(out, 'SERVER_URL', doc.serverUrl)
  put(out, 'NEXT_PUBLIC_SERVER_URL', doc.publicServerUrl)
  putNumber(out, 'TRUSTED_PROXY_COUNT', doc.trustedProxyCount)

  put(out, 'MODEL_GATEWAY_BASE_URL', doc.modelGatewayBaseUrl)
  putSecret(out, 'MODEL_GATEWAY_KEY', doc.modelGatewayKeyEncrypted)
  put(out, 'MODEL_GATEWAY_DEFAULT_MODEL', doc.modelGatewayDefaultModel)
  put(out, 'APPROVED_PLATFORM_MODELS', doc.approvedPlatformModels)
  putNumber(out, 'RUN_RATE_LIMIT_PER_MIN', doc.runRateLimitPerMin)
  putNumber(out, 'BENCHMARK_QUEUE_MAX_JOBS', doc.benchmarkQueueMaxJobs)
  putNumber(out, 'BENCHMARK_MAX_ATTEMPTS_PER_SKILL', doc.benchmarkMaxAttemptsPerSkill)
  put(out, 'BENCHMARK_MODELS', doc.benchmarkModels)

  put(out, 'NEWAPI_ADMIN_BASE_URL', doc.newapiAdminBaseUrl)
  putSecret(out, 'NEWAPI_ADMIN_KEY', doc.newapiAdminKeyEncrypted)
  put(out, 'NEWAPI_ADMIN_USER_ID', doc.newapiAdminUserId)
  putBoolFlag(out, 'NEWAPI_AUTH_BEARER', doc.newapiAuthBearer)
  put(out, 'NEWAPI_SUB_GROUP', doc.newapiSubGroup)
  putBoolFlag(out, 'ALLOW_DEFAULT_NEWAPI_SUB_GROUP', doc.allowDefaultNewapiSubGroup)
  putNumber(out, 'NEWAPI_CREDIT_TO_QUOTA', doc.newapiCreditToQuota)
  putNumber(out, 'NEWAPI_SUB_TOKEN_TTL_DAYS', doc.newapiSubTokenTtlDays)
  put(out, 'NEWAPI_USAGE_SOURCE', doc.newapiUsageSource)
  put(out, 'NEWAPI_LOG_SCOPE', doc.newapiLogScope)
  putNumber(out, 'NEWAPI_MARGIN_RATE', doc.newapiMarginRate)
  put(out, 'NEWAPI_MODEL_MARGIN_RATES', doc.newapiModelMarginRates)
  putNumber(out, 'NEWAPI_RECONCILE_TOLERANCE_CENTS', doc.newapiReconcileToleranceCents)
  putNumber(out, 'NEWAPI_USD_EXCHANGE_RATE_CNY', doc.newapiUsdExchangeRateCny)
  putBoolFlag(out, 'ALLOW_LOCAL_MARGIN_EXCHANGE', doc.allowLocalMarginExchange)

  putSecret(out, 'HENGSHU_SIGNING_KEY', doc.signingKeyEncrypted)
  putBoolFlag(out, 'BACKUP_ENCRYPTION_CONFIRMED', doc.backupEncryptionConfirmed)
  putBoolFlag(out, 'BACKUP_OFFSITE_CONFIRMED', doc.backupOffsiteConfirmed)
  put(out, 'BACKUP_RESTORE_DRILL_AT', doc.backupRestoreDrillAt)

  return out
}

export async function resolveRuntimeEnv(payload?: Payload, base: RuntimeEnv = process.env): Promise<RuntimeEnv> {
  if (!payload) return { ...base }
  try {
    const doc = await payload.findGlobal({ slug: 'deployment-settings' as any, depth: 0, overrideAccess: true })
    return deploymentSettingsToEnv(doc, base)
  } catch (e) {
    payload.logger?.warn?.(`部署设置未就绪，回退 env：${(e as Error).message}`)
    return { ...base }
  }
}

export function modelGatewayConfigured(env: RuntimeEnv): boolean {
  return Boolean(env.MODEL_GATEWAY_BASE_URL?.trim() && env.MODEL_GATEWAY_KEY?.trim())
}

export function newApiAdminConfigured(env: RuntimeEnv): boolean {
  return Boolean(env.NEWAPI_ADMIN_BASE_URL?.trim() && env.NEWAPI_ADMIN_KEY?.trim())
}
