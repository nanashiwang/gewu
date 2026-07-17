import { createPrivateKey } from 'crypto'
import { approvedPlatformModelList } from './constants'
import { resolveReconcileModelMarginRates } from './newapiReconcile'
import { parseTrustedAnchorPublishers } from './anchorVerify'

export type PreflightLevel = 'blocker' | 'warning'
export interface PreflightIssue {
  level: PreflightLevel
  code: string
  message: string
}

type Env = Record<string, string | undefined>

function present(env: Env, key: string): boolean {
  return Boolean(env[key]?.trim())
}

function num(env: Env, key: string): number {
  return Number(env[key] || 0)
}

function add(issues: PreflightIssue[], level: PreflightLevel, code: string, message: string) {
  issues.push({ level, code, message })
}

function parseUrl(value: string | undefined): URL | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function parseHttpsUrl(value: string | undefined): URL | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function signingKeyValid(value?: string): boolean {
  if (!value?.trim()) return false
  try {
    createPrivateKey({ key: Buffer.from(value.trim(), 'base64'), format: 'der', type: 'pkcs8' })
    return true
  } catch {
    return false
  }
}

function looksForeignModel(model: string): boolean {
  const m = model.toLowerCase()
  return ['claude', 'gpt', 'grok', 'gemini'].some((x) => m.includes(x))
}

function parseBackupDrillDate(value?: string): Date | null {
  const raw = value?.trim()
  if (!raw) return null
  const d = new Date(raw)
  return Number.isFinite(d.getTime()) ? d : null
}

function validateTrustedAnchorPublishers(raw: string | undefined): string[] {
  const value = raw?.trim()
  if (!value) return []
  const errors: string[] = []
  const items = value.split(',').map((x) => x.trim()).filter(Boolean)
  const parsed = parseTrustedAnchorPublishers(value)
  if (parsed.length !== items.length) errors.push('解析结果为空或条目数量不一致')
  for (const item of parsed) {
    if (!item.target && !item.urlPrefix) {
      errors.push('存在空发布目标')
      continue
    }
    if (item.target && !/^[a-zA-Z0-9_.:-]+$/.test(item.target)) {
      errors.push(`target 含非法字符：${item.target}`)
    }
    if (item.urlPrefix) {
      try {
        const url = new URL(item.urlPrefix)
        if (url.protocol !== 'https:') errors.push(`urlPrefix 必须使用 https：${item.urlPrefix}`)
      } catch {
        errors.push(`urlPrefix 不是合法 URL：${item.urlPrefix}`)
      }
    }
  }
  return errors
}


function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local')) return true
  if (/^(127|10)\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  const m = host.match(/^172\.(\d+)\./)
  if (m) {
    const n = Number(m[1])
    if (n >= 16 && n <= 31) return true
  }
  return host === '::1' || host === '[::1]'
}

export function checkPrivateDeployEnv(env: Env = process.env): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  const secret = env.PAYLOAD_SECRET || ''
  if (!secret || secret.length < 32 || /change_me|dev_secret|gewu-dev-secret/i.test(secret)) {
    add(issues, 'blocker', 'PAYLOAD_SECRET_WEAK', 'PAYLOAD_SECRET 必须是 32 字符以上强随机值')
  }
  const pgPassword = env.POSTGRES_PASSWORD || ''
  if (!pgPassword || pgPassword.length < 12 || /change_me|payload|password/i.test(pgPassword)) {
    add(issues, 'blocker', 'POSTGRES_PASSWORD_WEAK', 'POSTGRES_PASSWORD 必须改成 12 字符以上强密码')
  }
  const serverUrl = parseUrl(env.SERVER_URL)
  const publicUrl = parseUrl(env.NEXT_PUBLIC_SERVER_URL)
  if (!serverUrl) add(issues, 'blocker', 'SERVER_URL_INVALID', 'SERVER_URL 必须是合法 URL；NAS 内网可用 http://NAS_IP:8787')
  if (!publicUrl) add(issues, 'blocker', 'NEXT_PUBLIC_SERVER_URL_INVALID', 'NEXT_PUBLIC_SERVER_URL 必须是合法 URL；NAS 内网可用 http://NAS_IP:8787')
  if (serverUrl && publicUrl && serverUrl.origin !== publicUrl.origin) {
    add(issues, 'blocker', 'SITE_URL_ORIGIN_MISMATCH', 'SERVER_URL 与 NEXT_PUBLIC_SERVER_URL 必须同源，避免 Cookie/CORS 行为异常')
  }
  for (const [key, url] of [['SERVER_URL', serverUrl], ['NEXT_PUBLIC_SERVER_URL', publicUrl]] as const) {
    if (!url || url.protocol === 'https:') continue
    if (url.protocol !== 'http:') {
      add(issues, 'blocker', `${key}_SCHEME_INVALID`, `${key} 只支持 http 或 https`)
      continue
    }
    if (!isPrivateOrLocalHost(url.hostname)) {
      add(issues, 'warning', `${key}_PUBLIC_HTTP`, `${key} 使用公网 HTTP；仅建议 NAS 内网试跑，公网请改 HTTPS`)
    }
  }
  if (present(env, 'APP_PORT')) {
    const port = Number(env.APP_PORT)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      add(issues, 'blocker', 'APP_PORT_INVALID', 'APP_PORT 必须是 1-65535 的端口号')
    }
  }
  if (!present(env, 'SERVER_URL') || !present(env, 'NEXT_PUBLIC_SERVER_URL')) {
    add(issues, 'blocker', 'SITE_URL_MISSING', 'NAS 部署必须显式配置 SERVER_URL 和 NEXT_PUBLIC_SERVER_URL')
  }
  if (env.BACKUP_ENCRYPTION_CONFIRMED !== '1' || env.BACKUP_OFFSITE_CONFIRMED !== '1') {
    add(issues, 'warning', 'BACKUP_NOT_CONFIRMED', '私有部署可先启动，但正式存放业务数据前应确认备份加密和离机保存')
  }
  if (!present(env, 'MEDIA_DIR')) {
    add(issues, 'warning', 'MEDIA_DIR_DEFAULT', '未显式配置 MEDIA_DIR；Compose 默认挂载 /app/media，裸机部署需确认媒体目录持久化')
  }
  return issues
}


export function checkStartupEnv(env: Env = process.env): PreflightIssue[] {
  const issues: PreflightIssue[] = []

  const secret = env.PAYLOAD_SECRET || ''
  if (!secret || secret.length < 32 || /change_me|dev_secret|gewu-dev-secret/i.test(secret)) {
    add(issues, 'blocker', 'PAYLOAD_SECRET_WEAK', 'PAYLOAD_SECRET 必须是 32 字符以上强随机值')
  }

  if (!present(env, 'DATABASE_URL')) {
    add(issues, 'blocker', 'DATABASE_URL_MISSING', '缺少 DATABASE_URL')
  } else if (/payload:payload@/.test(env.DATABASE_URL || '')) {
    add(issues, 'warning', 'DATABASE_DEFAULT_CREDENTIALS', 'DATABASE_URL 仍像默认开发账号，请确认 NAS/生产数据库密码已更换')
  }

  if (!present(env, 'SERVER_URL') || !present(env, 'NEXT_PUBLIC_SERVER_URL')) {
    add(issues, 'warning', 'SITE_URL_USING_DEFAULT', '未显式配置站点地址时会按 compose 默认 localhost；NAS 建议改成 http://NAS_IP:8787')
  }
  if (!present(env, 'REDIS_URL')) {
    add(issues, 'warning', 'REDIS_URL_MISSING', '缺少 REDIS_URL；队列/分布式限流会降级或跳过')
  }

  return issues
}

export function checkProductionEnv(env: Env = process.env): PreflightIssue[] {
  const issues: PreflightIssue[] = []

  const secret = env.PAYLOAD_SECRET || ''
  if (!secret || secret.length < 32 || /change_me|dev_secret|gewu-dev-secret/i.test(secret)) {
    add(issues, 'blocker', 'PAYLOAD_SECRET_WEAK', 'PAYLOAD_SECRET 必须是 32 字符以上强随机值')
  }

  if (!present(env, 'DATABASE_URL')) {
    add(issues, 'blocker', 'DATABASE_URL_MISSING', '缺少 DATABASE_URL')
  } else if (/payload:payload@/.test(env.DATABASE_URL || '')) {
    add(issues, 'warning', 'DATABASE_DEFAULT_CREDENTIALS', 'DATABASE_URL 仍像默认开发账号，请确认生产数据库密码已更换')
  }

  const serverUrl = parseHttpsUrl(env.SERVER_URL)
  const publicUrl = parseHttpsUrl(env.NEXT_PUBLIC_SERVER_URL)
  if (!present(env, 'SERVER_URL')) {
    add(issues, 'blocker', 'SERVER_URL_MISSING', '缺少 SERVER_URL；生产服务端必须显式配置 https:// 公网域名')
  } else if (!serverUrl) {
    add(issues, 'blocker', 'SITE_URL_NOT_HTTPS', 'SERVER_URL 生产必须是有效 https:// 域名')
  }
  if (!present(env, 'NEXT_PUBLIC_SERVER_URL')) {
    add(issues, 'blocker', 'NEXT_PUBLIC_SERVER_URL_MISSING', '缺少 NEXT_PUBLIC_SERVER_URL；生产客户端/CORS/CSRF 必须显式配置公网域名')
  } else if (!publicUrl) {
    add(issues, 'blocker', 'SITE_URL_NOT_HTTPS', 'NEXT_PUBLIC_SERVER_URL 生产必须是有效 https:// 域名')
  }
  if (serverUrl && publicUrl && serverUrl.origin !== publicUrl.origin) {
    add(
      issues,
      'blocker',
      'SITE_URL_ORIGIN_MISMATCH',
      'SERVER_URL 与 NEXT_PUBLIC_SERVER_URL 必须同源，避免 CORS/CSRF 放宽到多个生产来源',
    )
  }

  if (!present(env, 'REDIS_URL')) {
    add(issues, 'blocker', 'REDIS_URL_MISSING', '缺少 REDIS_URL；生产平台代付限流不能退回单机计数')
  }

  if (!present(env, 'MODEL_GATEWAY_BASE_URL')) {
    add(issues, 'blocker', 'MODEL_GATEWAY_BASE_URL_MISSING', '缺少 MODEL_GATEWAY_BASE_URL；生产禁止 mock 运行')
  }
  if (!present(env, 'MODEL_GATEWAY_KEY')) {
    add(issues, 'blocker', 'MODEL_GATEWAY_KEY_MISSING', '缺少 MODEL_GATEWAY_KEY；发布即评测无法产生真实数据')
  }

  const allowList = approvedPlatformModelList(env)
  if (allowList.length === 0) {
    add(
      issues,
      'blocker',
      'APPROVED_PLATFORM_MODELS_EMPTY',
      'APPROVED_PLATFORM_MODELS 显式配置后解析为空；生产平台代付白名单不能为空',
    )
  }
  const unsafeModels = allowList.filter(looksForeignModel)
  if (unsafeModels.length > 0) {
    add(issues, 'blocker', 'APPROVED_PLATFORM_MODELS_UNSAFE', `平台代付白名单包含非国产/未备案模型：${unsafeModels.join(',')}`)
  }
  const defaultModel = env.MODEL_GATEWAY_DEFAULT_MODEL || 'deepseek-chat'
  if (!allowList.includes(defaultModel)) {
    add(issues, 'warning', 'DEFAULT_MODEL_NOT_APPROVED', 'MODEL_GATEWAY_DEFAULT_MODEL 不在平台代付白名单内，将由代码降级到安全默认模型')
  }

  for (const key of ['NEWAPI_ADMIN_BASE_URL', 'NEWAPI_ADMIN_KEY', 'NEWAPI_ADMIN_USER_ID']) {
    if (!present(env, key)) add(issues, 'blocker', `${key}_MISSING`, `缺少 ${key}，生产平台代付无法按用户子令牌隔离`)
  }
  if ((env.NEWAPI_ADMIN_KEY || '').trim().startsWith('sk-')) {
    add(issues, 'blocker', 'NEWAPI_ADMIN_KEY_LOOKS_MODEL_KEY', 'NEWAPI_ADMIN_KEY 看起来是模型 sk Key，不是后台系统访问令牌')
  }
  if (present(env, 'NEWAPI_ADMIN_USER_ID') && !/^\d+$/.test((env.NEWAPI_ADMIN_USER_ID || '').trim())) {
    add(issues, 'blocker', 'NEWAPI_ADMIN_USER_ID_INVALID', 'NEWAPI_ADMIN_USER_ID 必须是 New API 平台账号数字 ID')
  }
  if (!present(env, 'NEWAPI_SUB_GROUP')) {
    if (env.ALLOW_DEFAULT_NEWAPI_SUB_GROUP !== '1') {
      add(
        issues,
        'blocker',
        'NEWAPI_SUB_GROUP_MISSING',
        'NEWAPI_SUB_GROUP 未配置；生产必须指定低价/受限分组，或显式设置 ALLOW_DEFAULT_NEWAPI_SUB_GROUP=1 确认默认分组安全',
      )
    } else {
      add(
        issues,
        'warning',
        'NEWAPI_DEFAULT_SUB_GROUP_CONFIRMED',
        '已显式确认 New API 默认分组安全；请保留校准证据，避免平台代付落到高价/非受限分组',
      )
    }
  }
  if (!Number.isFinite(num(env, 'NEWAPI_CREDIT_TO_QUOTA')) || num(env, 'NEWAPI_CREDIT_TO_QUOTA') <= 0) {
    add(issues, 'blocker', 'NEWAPI_CREDIT_TO_QUOTA_INVALID', 'NEWAPI_CREDIT_TO_QUOTA 必须按真实售价校准为正数')
  }
  const subTokenTtlDays = present(env, 'NEWAPI_SUB_TOKEN_TTL_DAYS') ? num(env, 'NEWAPI_SUB_TOKEN_TTL_DAYS') : 7
  if (!Number.isFinite(subTokenTtlDays) || subTokenTtlDays <= 0 || subTokenTtlDays > 365) {
    add(issues, 'blocker', 'NEWAPI_SUB_TOKEN_TTL_INVALID', 'NEWAPI_SUB_TOKEN_TTL_DAYS 必须是 1-365 天；生产不得创建永不过期或异常长效子令牌')
  }

  const usageSource = env.NEWAPI_USAGE_SOURCE || 'newapi'
  if (!['newapi', 'local'].includes(usageSource)) {
    add(issues, 'blocker', 'NEWAPI_USAGE_SOURCE_INVALID', 'NEWAPI_USAGE_SOURCE 必须是 newapi 或 local')
  }

  const marginRateRaw = env.NEWAPI_MARGIN_RATE?.trim()
  const marginRate = marginRateRaw ? Number(marginRateRaw) : 0
  if (!marginRateRaw) {
    if (usageSource === 'local') {
      add(issues, 'warning', 'NEWAPI_MARGIN_RATE_UNSET', 'NEWAPI_USAGE_SOURCE=local 时 NEWAPI_MARGIN_RATE 未配置，兑换池不会有可信毛利真值')
    }
  } else if (!Number.isFinite(marginRate) || marginRate < 0 || marginRate > 1 || (usageSource === 'local' && marginRate <= 0)) {
    add(issues, 'blocker', 'NEWAPI_MARGIN_RATE_INVALID', 'NEWAPI_MARGIN_RATE 必须是 0-1 之间的数字；local 写回时必须大于 0')
  } else if (usageSource === 'newapi') {
    add(issues, 'warning', 'NEWAPI_MARGIN_RATE_DRY_RUN_ONLY', 'NEWAPI_USAGE_SOURCE=newapi 已改用 /api/log token × /api/pricing 精算，NEWAPI_MARGIN_RATE 只作旧口径对照')
  }
  let modelMarginRates = new Map<string, number>()
  try {
    modelMarginRates = resolveReconcileModelMarginRates(env)
  } catch (e) {
    add(issues, 'blocker', 'NEWAPI_MODEL_MARGIN_RATES_INVALID', (e as Error).message)
  }
  if (usageSource === 'newapi') {
    if (present(env, 'NEWAPI_MODEL_MARGIN_RATES')) {
      const missing = allowList.filter((model) => !modelMarginRates.has(model))
      if (missing.length > 0) {
        add(
          issues,
          'warning',
          'NEWAPI_MODEL_MARGIN_RATES_MISSING_MODELS',
          `NEWAPI_MODEL_MARGIN_RATES 仅作 dry-run 对照，当前缺少平台代付白名单模型：${missing.join(',')}`,
        )
      }
    } else {
      add(
        issues,
        'warning',
        'NEWAPI_MODEL_MARGIN_RATES_DRY_RUN_UNSET',
        'NEWAPI_MODEL_MARGIN_RATES 未配置：允许生产启动，真钱毛利以 /api/log token × /api/pricing 为准',
      )
    }
  }
  if (present(env, 'NEWAPI_RECONCILE_TOLERANCE_CENTS')) {
    const tolerance = num(env, 'NEWAPI_RECONCILE_TOLERANCE_CENTS')
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      add(
        issues,
        'blocker',
        'NEWAPI_RECONCILE_TOLERANCE_INVALID',
        'NEWAPI_RECONCILE_TOLERANCE_CENTS 必须是非负数字，禁止非法漂移容忍值进入生产',
      )
    }
  }
  if (usageSource === 'local') {
    if (env.ALLOW_LOCAL_MARGIN_EXCHANGE !== '1') {
      add(
        issues,
        'blocker',
        'LOCAL_MARGIN_EXCHANGE_NOT_CONFIRMED',
        'NEWAPI_USAGE_SOURCE=local 只是保守估算；必须显式设置 ALLOW_LOCAL_MARGIN_EXCHANGE=1 才能写回并开放兑换',
      )
    } else {
      add(
        issues,
        'warning',
        'NEWAPI_USAGE_SOURCE_LOCAL',
        'NEWAPI_USAGE_SOURCE=local 只是保守估算；确认已书面记录毛利率/配额口径',
      )
    }
  } else if (env.ALLOW_LOCAL_MARGIN_EXCHANGE === '1') {
    add(
      issues,
      'warning',
      'LOCAL_MARGIN_CONFIRMATION_STALE',
      'ALLOW_LOCAL_MARGIN_EXCHANGE=1 但 NEWAPI_USAGE_SOURCE 不是 local；请清理旧确认，避免误以为本地估算仍会生效',
    )
  }

  if (!signingKeyValid(env.GEWU_SIGNING_KEY)) {
    add(issues, 'blocker', 'GEWU_SIGNING_KEY_INVALID', 'GEWU_SIGNING_KEY 缺失或不是有效 ed25519 PKCS8 base64 私钥')
  }
  if (!present(env, 'ANCHOR_TRUSTED_PUBLISHERS')) {
    add(issues, 'warning', 'ANCHOR_TRUSTED_PUBLISHERS_MISSING', '未配置外锚可信发布目标；/v1/anchors/verify 只能验签，无法判断 publishedTo 是否命中可信网络')
  } else {
    const anchorErrors = validateTrustedAnchorPublishers(env.ANCHOR_TRUSTED_PUBLISHERS)
    if (anchorErrors.length > 0) {
      add(
        issues,
        'blocker',
        'ANCHOR_TRUSTED_PUBLISHERS_INVALID',
        `ANCHOR_TRUSTED_PUBLISHERS 格式无效：${anchorErrors.join('；')}`,
      )
    }
  }
  if (env.ALLOW_LEGACY_RUNNER_TOKEN_AUTH === '1') {
    add(issues, 'blocker', 'ALLOW_LEGACY_RUNNER_TOKEN_AUTH_ON', '生产不得开启 ALLOW_LEGACY_RUNNER_TOKEN_AUTH=1')
  }
  if (!present(env, 'TRUSTED_PROXY_COUNT')) {
    add(issues, 'warning', 'TRUSTED_PROXY_COUNT_MISSING', 'TRUSTED_PROXY_COUNT 未设置；反代 XFF 取真实 IP 的边界需上线前确认')
  }

  if (env.BACKUP_ENCRYPTION_CONFIRMED !== '1') {
    add(issues, 'blocker', 'BACKUP_ENCRYPTION_NOT_CONFIRMED', '生产备份必须确认已加密，密钥不得放在同一服务器')
  }
  if (env.BACKUP_OFFSITE_CONFIRMED !== '1') {
    add(issues, 'blocker', 'BACKUP_OFFSITE_NOT_CONFIRMED', '生产备份必须确认已离机保存')
  }
  const drillAt = parseBackupDrillDate(env.BACKUP_RESTORE_DRILL_AT)
  if (!drillAt) {
    add(issues, 'blocker', 'BACKUP_RESTORE_DRILL_MISSING', '缺少 BACKUP_RESTORE_DRILL_AT；上线前必须做一次恢复演练')
  } else {
    const ageMs = Date.now() - drillAt.getTime()
    if (ageMs > 35 * 24 * 60 * 60 * 1000) {
      add(issues, 'warning', 'BACKUP_RESTORE_DRILL_STALE', '最近一次备份恢复演练已超过 35 天，请尽快复演')
    }
  }

  return issues
}

export function countBlockers(issues: PreflightIssue[]): number {
  return issues.filter((i) => i.level === 'blocker').length
}
