import { generateKeyPairSync } from 'crypto'
import { describe, expect, it } from 'vitest'
import { checkPrivateDeployEnv, checkProductionEnv, checkStartupEnv, countBlockers } from '@/lib/productionPreflight'

function signingKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
}

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PAYLOAD_SECRET: 'prod-secret-32-bytes-minimum-value',
    DATABASE_URL: 'postgres://app:strong@postgres:5432/gewu',
    SERVER_URL: 'https://gewu.example.com',
    NEXT_PUBLIC_SERVER_URL: 'https://gewu.example.com',
    REDIS_URL: 'redis://redis:6379',
    DETECTOR_BASE_URL: 'http://detector:8765',
    DETECTOR_PUBLIC_URL: 'https://gewu.example.com',
    RELAY_CRON_SECRET: 'relay-cron-secret-32-bytes-minimum',
    MODEL_GATEWAY_BASE_URL: 'https://gateway.example.com',
    MODEL_GATEWAY_KEY: 'platform-model-key',
    MODEL_GATEWAY_DEFAULT_MODEL: 'deepseek-chat',
    APPROVED_PLATFORM_MODELS: 'deepseek-chat,qwen-plus,glm-4',
    NEWAPI_ADMIN_BASE_URL: 'https://newapi.example.com',
    NEWAPI_ADMIN_KEY: 'admin-access-token',
    NEWAPI_ADMIN_USER_ID: '1001',
    NEWAPI_SUB_GROUP: 'platform-lowcost',
    NEWAPI_CREDIT_TO_QUOTA: '700',
    NEWAPI_MARGIN_RATE: '0.3',
    NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat=0.25,qwen-plus=0.18,glm-4=0.22',
    NEWAPI_USAGE_SOURCE: 'newapi',
    GEWU_SIGNING_KEY: signingKey(),
    TRUSTED_PROXY_COUNT: '1',
    BACKUP_ENCRYPTION_CONFIRMED: '1',
    BACKUP_OFFSITE_CONFIRMED: '1',
    BACKUP_RESTORE_DRILL_AT: new Date().toISOString().slice(0, 10),
    ANCHOR_TRUSTED_PUBLISHERS: 'github-release|https://github.com/acme/gewu/releases/',
    ...overrides,
  }
}

describe('productionPreflight — 生产上线配置门禁', () => {



  it('私有部署 readiness 允许 NAS 内网 HTTP，但阻断默认密钥和弱数据库密码', () => {
    const issues = checkPrivateDeployEnv({
      PAYLOAD_SECRET: 'CHANGE_ME_USE_OPENSSL_RAND_HEX_32',
      POSTGRES_PASSWORD: 'payload',
      APP_PORT: '8787',
      SERVER_URL: 'http://192.168.1.20:8787',
      NEXT_PUBLIC_SERVER_URL: 'http://192.168.1.20:8787',
    })
    const codes = issues.filter((i) => i.level === 'blocker').map((i) => i.code)
    expect(codes).toContain('PAYLOAD_SECRET_WEAK')
    expect(codes).toContain('POSTGRES_PASSWORD_WEAK')
    expect(issues.map((i) => i.code)).not.toContain('SERVER_URL_PUBLIC_HTTP')
  })

  it('私有部署 readiness 检查同源、端口和公网 HTTP 风险', () => {
    const issues = checkPrivateDeployEnv({
      PAYLOAD_SECRET: 'prod-secret-32-bytes-minimum-value',
      POSTGRES_PASSWORD: 'strong-db-secret',
      APP_PORT: '99999',
      SERVER_URL: 'http://nas.example.com:8787',
      NEXT_PUBLIC_SERVER_URL: 'http://other.example.com:8787',
      MEDIA_DIR: '/app/media',
      BACKUP_ENCRYPTION_CONFIRMED: '1',
      BACKUP_OFFSITE_CONFIRMED: '1',
    })
    const codes = issues.map((i) => i.code)
    expect(codes).toContain('SITE_URL_ORIGIN_MISMATCH')
    expect(codes).toContain('APP_PORT_INVALID')
    expect(codes).toContain('SERVER_URL_PUBLIC_HTTP')
  })

  it('私有部署 readiness 强配置通过时只保留可接受提示', () => {
    const issues = checkPrivateDeployEnv({
      PAYLOAD_SECRET: 'prod-secret-32-bytes-minimum-value',
      POSTGRES_PASSWORD: 'strong-db-secret',
      APP_PORT: '8787',
      SERVER_URL: 'http://nas.local:8787',
      NEXT_PUBLIC_SERVER_URL: 'http://nas.local:8787',
      MEDIA_DIR: '/app/media',
      BACKUP_ENCRYPTION_CONFIRMED: '1',
      BACKUP_OFFSITE_CONFIRMED: '1',
    })
    expect(countBlockers(issues)).toBe(0)
  })

  it('启动预检只要求基础依赖，不阻断后台后置配置', () => {
    const issues = checkStartupEnv({
      PAYLOAD_SECRET: 'prod-secret-32-bytes-minimum-value',
      DATABASE_URL: 'postgres://app:strong@postgres:5432/gewu',
      SERVER_URL: 'http://nas.local:8787',
      NEXT_PUBLIC_SERVER_URL: 'http://nas.local:8787',
      REDIS_URL: 'redis://redis:6379',
    })
    expect(countBlockers(issues)).toBe(0)
    expect(issues.map((i) => i.code)).not.toContain('MODEL_GATEWAY_BASE_URL_MISSING')
    expect(issues.map((i) => i.code)).not.toContain('GEWU_SIGNING_KEY_INVALID')
  })
  it('完整生产配置无阻断项', () => {
    const issues = checkProductionEnv(validEnv())
    expect(countBlockers(issues)).toBe(0)
  })

  it('阻断开发默认密钥、HTTP 域名、缺 Redis/网关/签名私钥', () => {
    const issues = checkProductionEnv(
      validEnv({
        PAYLOAD_SECRET: 'CHANGE_ME_DEV_SECRET',
        SERVER_URL: 'http://localhost:3000',
        NEXT_PUBLIC_SERVER_URL: 'http://localhost:3000',
        REDIS_URL: '',
        MODEL_GATEWAY_BASE_URL: '',
        GEWU_SIGNING_KEY: '',
      }),
    )
    const codes = issues.filter((i) => i.level === 'blocker').map((i) => i.code)
    expect(codes).toContain('PAYLOAD_SECRET_WEAK')
    expect(codes).toContain('SITE_URL_NOT_HTTPS')
    expect(codes).toContain('REDIS_URL_MISSING')
    expect(codes).toContain('MODEL_GATEWAY_BASE_URL_MISSING')
    expect(codes).toContain('GEWU_SIGNING_KEY_INVALID')
  })

  it('生产缺 SERVER_URL 或 NEXT_PUBLIC_SERVER_URL 直接阻断', () => {
    const issues = checkProductionEnv(validEnv({ SERVER_URL: undefined }))
    expect(issues.map((i) => i.code)).toContain('SERVER_URL_MISSING')
    expect(countBlockers(issues)).toBeGreaterThan(0)

    const noPublic = checkProductionEnv(validEnv({ NEXT_PUBLIC_SERVER_URL: undefined }))
    expect(noPublic.map((i) => i.code)).toContain('NEXT_PUBLIC_SERVER_URL_MISSING')
    expect(countBlockers(noPublic)).toBeGreaterThan(0)
  })

  it('阻断 SERVER_URL 与 NEXT_PUBLIC_SERVER_URL 不同源，避免 CSRF/CORS 放宽', () => {
    const issues = checkProductionEnv(
      validEnv({
        SERVER_URL: 'https://api.gewu.example.com',
        NEXT_PUBLIC_SERVER_URL: 'https://gewu.example.com',
      }),
    )
    expect(issues.map((i) => i.code)).toContain('SITE_URL_ORIGIN_MISMATCH')
  })

  it('阻断 sk 模型 Key 冒充 New API 管理 access token', () => {
    const issues = checkProductionEnv(validEnv({ NEWAPI_ADMIN_KEY: 'sk-this-is-not-admin' }))
    expect(issues.map((i) => i.code)).toContain('NEWAPI_ADMIN_KEY_LOOKS_MODEL_KEY')
  })

  it('缺 NEWAPI_SUB_GROUP 会阻断，避免平台代付落到未知默认分组', () => {
    const issues = checkProductionEnv(validEnv({ NEWAPI_SUB_GROUP: '' }))
    expect(issues.map((i) => i.code)).toContain('NEWAPI_SUB_GROUP_MISSING')
    expect(countBlockers(issues)).toBeGreaterThan(0)
  })

  it('显式确认默认分组安全后只警告，不阻断生产启动', () => {
    const issues = checkProductionEnv(
      validEnv({ NEWAPI_SUB_GROUP: '', ALLOW_DEFAULT_NEWAPI_SUB_GROUP: '1' }),
    )
    expect(issues.map((i) => i.code)).toContain('NEWAPI_DEFAULT_SUB_GROUP_CONFIRMED')
    expect(countBlockers(issues)).toBe(0)
  })

  it('阻断平台代付白名单混入境外模型', () => {
    const issues = checkProductionEnv(validEnv({ APPROVED_PLATFORM_MODELS: 'deepseek-chat,claude-sonnet-4-6' }))
    expect(issues.map((i) => i.code)).toContain('APPROVED_PLATFORM_MODELS_UNSAFE')
  })

  it('阻断非法 New API 子令牌 TTL，避免永不过期或异常长效令牌', () => {
    const issues = checkProductionEnv(validEnv({ NEWAPI_SUB_TOKEN_TTL_DAYS: '0' }))
    expect(issues.map((i) => i.code)).toContain('NEWAPI_SUB_TOKEN_TTL_INVALID')
    expect(countBlockers(issues)).toBeGreaterThan(0)
  })

  it('阻断显式配置为空的平台代理模型白名单，避免子令牌 model_limits 为空', () => {
    const issues = checkProductionEnv(validEnv({ APPROVED_PLATFORM_MODELS: ', ,' }))
    expect(issues.map((i) => i.code)).toContain('APPROVED_PLATFORM_MODELS_EMPTY')
    expect(countBlockers(issues)).toBeGreaterThan(0)
  })

  it('local 毛利估算未显式确认时阻断上线，确认后只保留警告', () => {
    const blocked = checkProductionEnv(validEnv({ NEWAPI_USAGE_SOURCE: 'local', ALLOW_LOCAL_MARGIN_EXCHANGE: '' }))
    expect(blocked.map((i) => i.code)).toContain('LOCAL_MARGIN_EXCHANGE_NOT_CONFIRMED')

    const confirmed = checkProductionEnv(
      validEnv({ NEWAPI_USAGE_SOURCE: 'local', ALLOW_LOCAL_MARGIN_EXCHANGE: '1' }),
    )
    expect(confirmed.map((i) => i.code)).not.toContain('LOCAL_MARGIN_EXCHANGE_NOT_CONFIRMED')
    expect(confirmed.map((i) => i.code)).toContain('NEWAPI_USAGE_SOURCE_LOCAL')
    expect(countBlockers(confirmed)).toBe(0)
  })

  it('NEWAPI_USAGE_SOURCE 不是 local 时提示清理旧 local 毛利确认', () => {
    const issues = checkProductionEnv(validEnv({ NEWAPI_USAGE_SOURCE: 'newapi', ALLOW_LOCAL_MARGIN_EXCHANGE: '1' }))
    expect(issues.map((i) => i.code)).toContain('LOCAL_MARGIN_CONFIRMATION_STALE')
    expect(countBlockers(issues)).toBe(0)
  })

  it('阻断非法 New API 用量来源、毛利率和漂移容忍值，避免生产对账口径静默回退', () => {
    const issues = checkProductionEnv(
      validEnv({
        NEWAPI_USAGE_SOURCE: 'manual',
        NEWAPI_MARGIN_RATE: '1.2',
        NEWAPI_RECONCILE_TOLERANCE_CENTS: 'NaN',
      }),
    )
    const codes = issues.filter((i) => i.level === 'blocker').map((i) => i.code)
    expect(codes).toContain('NEWAPI_USAGE_SOURCE_INVALID')
    expect(codes).toContain('NEWAPI_MARGIN_RATE_INVALID')
    expect(codes).toContain('NEWAPI_RECONCILE_TOLERANCE_INVALID')
  })

  it('newapi 真值对账不再强制模型毛利率，缺失只作为 dry-run 警告', () => {
    const missing = checkProductionEnv(validEnv({ NEWAPI_MODEL_MARGIN_RATES: '' }))
    expect(missing.map((i) => i.code)).toContain('NEWAPI_MODEL_MARGIN_RATES_DRY_RUN_UNSET')
    expect(countBlockers(missing)).toBe(0)

    const partial = checkProductionEnv(
      validEnv({ NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat=0.25,qwen-plus=0.18' }),
    )
    expect(partial.map((i) => i.code)).toContain('NEWAPI_MODEL_MARGIN_RATES_MISSING_MODELS')
    expect(countBlockers(partial)).toBe(0)

    const invalid = checkProductionEnv(validEnv({ NEWAPI_MODEL_MARGIN_RATES: 'deepseek-chat=1.2' }))
    expect(invalid.map((i) => i.code)).toContain('NEWAPI_MODEL_MARGIN_RATES_INVALID')
    expect(countBlockers(invalid)).toBeGreaterThan(0)
  })

  it('阻断未确认加密/离机/恢复演练的生产备份', () => {
    const issues = checkProductionEnv(
      validEnv({
        BACKUP_ENCRYPTION_CONFIRMED: '',
        BACKUP_OFFSITE_CONFIRMED: '',
        BACKUP_RESTORE_DRILL_AT: '',
      }),
    )
    const codes = issues.filter((i) => i.level === 'blocker').map((i) => i.code)
    expect(codes).toContain('BACKUP_ENCRYPTION_NOT_CONFIRMED')
    expect(codes).toContain('BACKUP_OFFSITE_NOT_CONFIRMED')
    expect(codes).toContain('BACKUP_RESTORE_DRILL_MISSING')
  })

  it('恢复演练超过 35 天只报警，不阻断已具备备份能力的生产启动', () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const issues = checkProductionEnv(validEnv({ BACKUP_RESTORE_DRILL_AT: old }))
    expect(issues.map((i) => i.code)).toContain('BACKUP_RESTORE_DRILL_STALE')
    expect(countBlockers(issues)).toBe(0)
  })

  it('可信发布目标缺失只警告，非法 URL 会阻断可信网络上线', () => {
    const missing = checkProductionEnv(validEnv({ ANCHOR_TRUSTED_PUBLISHERS: '' }))
    expect(missing.map((i) => i.code)).toContain('ANCHOR_TRUSTED_PUBLISHERS_MISSING')
    expect(countBlockers(missing)).toBe(0)

    const invalid = checkProductionEnv(validEnv({ ANCHOR_TRUSTED_PUBLISHERS: 'github|http://example.com/anchors/' }))
    expect(invalid.map((i) => i.code)).toContain('ANCHOR_TRUSTED_PUBLISHERS_INVALID')
    expect(countBlockers(invalid)).toBeGreaterThan(0)
  })
})
