import { afterEach, describe, expect, it, vi } from 'vitest'
import { decryptSecret } from '@/lib/secrets'
import { deploymentSettingsToEnv, normalizeDeploymentSecretFields } from '@/lib/deploymentSettings'

describe('deploymentSettings — 后台部署配置', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('保存时加密敏感字段，运行时解密并覆盖 env fallback', () => {
    vi.stubEnv('PAYLOAD_SECRET', 'test-secret-32-bytes-minimum-value')
    const doc = normalizeDeploymentSecretFields({
      modelGatewayBaseUrl: 'https://gateway.example',
      modelGatewayKeyEncrypted: 'platform-secret',
      newapiAdminBaseUrl: 'https://newapi.example',
      newapiAdminKeyEncrypted: 'admin-secret',
      newapiAuthBearer: true,
      signingKeyEncrypted: 'signing-secret',
      backupEncryptionConfirmed: true,
      anchorTrustedPublishers: 'github-release|https://github.com/acme/gewu/releases/',
    }) as any

    expect(doc.modelGatewayKeyEncrypted).toMatch(/^enc:v1:/)
    expect(doc.modelGatewayKeyEncrypted).not.toContain('platform-secret')
    expect(decryptSecret(doc.modelGatewayKeyEncrypted)).toBe('platform-secret')

    const env = deploymentSettingsToEnv(doc, {
      MODEL_GATEWAY_KEY: 'fallback-key',
      NEWAPI_AUTH_BEARER: undefined,
    })
    expect(env.MODEL_GATEWAY_BASE_URL).toBe('https://gateway.example')
    expect(env.MODEL_GATEWAY_KEY).toBe('platform-secret')
    expect(env.NEWAPI_ADMIN_KEY).toBe('admin-secret')
    expect(env.NEWAPI_AUTH_BEARER).toBe('1')
    expect(env.GEWU_SIGNING_KEY).toBe('signing-secret')
    expect(env.BACKUP_ENCRYPTION_CONFIRMED).toBe('1')
    expect(env.ANCHOR_TRUSTED_PUBLISHERS).toBe('github-release|https://github.com/acme/gewu/releases/')
  })

  it('空后台配置保留 env 兜底，避免迁移后旧部署立刻失效', () => {
    const env = deploymentSettingsToEnv({ modelGatewayKeyEncrypted: '' }, { MODEL_GATEWAY_KEY: 'fallback-key' })
    expect(env.MODEL_GATEWAY_KEY).toBe('fallback-key')
  })

  it('后台 checkbox 的 false 会覆盖旧 env=1，避免高风险开关被部署变量误开启', () => {
    const env = deploymentSettingsToEnv(
      {
        newapiAuthBearer: false,
        allowDefaultNewapiSubGroup: false,
        allowLocalMarginExchange: false,
        backupEncryptionConfirmed: false,
      },
      {
        NEWAPI_AUTH_BEARER: '1',
        ALLOW_DEFAULT_NEWAPI_SUB_GROUP: '1',
        ALLOW_LOCAL_MARGIN_EXCHANGE: '1',
        BACKUP_ENCRYPTION_CONFIRMED: '1',
      },
    )
    expect(env.NEWAPI_AUTH_BEARER).toBe('')
    expect(env.ALLOW_DEFAULT_NEWAPI_SUB_GROUP).toBe('')
    expect(env.ALLOW_LOCAL_MARGIN_EXCHANGE).toBe('')
    expect(env.BACKUP_ENCRYPTION_CONFIRMED).toBe('')
  })
})
