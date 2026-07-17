import type { GlobalConfig } from 'payload'
import { isAdmin } from '@/access'
import { normalizeDeploymentSecretFields } from '@/lib/deploymentSettings'

export const DeploymentSettings: GlobalConfig = {
  slug: 'deployment-settings',
  label: '部署设置',
  admin: {
    group: '系统设置',
    description: '部署后由管理员配置模型网关、New API、签名与备份状态；容器启动只依赖数据库和 PAYLOAD_SECRET。',
  },
  access: {
    read: isAdmin,
    update: isAdmin,
  },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: '基础地址',
          fields: [
            {
              name: 'serverUrl',
              type: 'text',
              label: '服务端公网地址',
              admin: { description: '例如 https://gewu.example.com；NAS 内网试跑可用 http://NAS_IP:8787。' },
            },
            {
              name: 'publicServerUrl',
              type: 'text',
              label: '浏览器访问地址',
              admin: { description: '通常与服务端公网地址同源；正式生产预检会阻断不同源。' },
            },
            {
              name: 'trustedProxyCount',
              type: 'number',
              label: '可信反代层数',
              admin: { description: 'NAS/内网直连通常填 0；Nginx/群晖反代 append XFF 时通常填 1。' },
            },
          ],
        },
        {
          label: '模型网关',
          fields: [
            { name: 'modelGatewayBaseUrl', type: 'text', label: 'OpenAI 兼容网关地址' },
            {
              name: 'modelGatewayKeyEncrypted',
              type: 'text',
              label: '模型网关 Key（保存后显示密文）',
              admin: { description: '可粘贴明文；保存时自动 AES-GCM 加密。留空表示暂不启用平台真实调用。' },
            },
            { name: 'modelGatewayDefaultModel', type: 'text', defaultValue: 'deepseek-chat', label: '默认模型' },
            {
              name: 'approvedPlatformModels',
              type: 'textarea',
              label: '平台代付模型白名单',
              admin: { description: '逗号分隔；留空使用系统默认国产模型白名单。' },
            },
            { name: 'runRateLimitPerMin', type: 'number', label: '每用户每分钟真实调用上限' },
            { name: 'benchmarkQueueMaxJobs', type: 'number', label: '评测队列每轮最大任务数' },
            { name: 'benchmarkMaxAttemptsPerSkill', type: 'number', label: '每个 Skill 最大评测次数' },
            { name: 'benchmarkModels', type: 'text', label: '评测模型列表（逗号分隔）' },
          ],
        },
        {
          label: 'New API',
          fields: [
            { name: 'newapiAdminBaseUrl', type: 'text', label: 'New API 管理地址' },
            {
              name: 'newapiAdminKeyEncrypted',
              type: 'text',
              label: 'New API 管理 Token（保存后显示密文）',
              admin: { description: '填系统访问令牌，不是模型 sk-* Key；保存时自动加密。' },
            },
            { name: 'newapiAdminUserId', type: 'text', label: 'New API 平台账号数字 ID' },
            { name: 'newapiAuthBearer', type: 'checkbox', label: 'Authorization 使用 Bearer 前缀' },
            { name: 'newapiSubGroup', type: 'text', label: '子令牌分组' },
            {
              name: 'allowDefaultNewapiSubGroup',
              type: 'checkbox',
              label: '已确认默认分组安全',
              admin: { description: '不推荐；仅在确认默认分组低价且受限时打开。' },
            },
            { name: 'newapiCreditToQuota', type: 'number', label: '1 credit 对应 quota' },
            { name: 'newapiSubTokenTtlDays', type: 'number', label: '子令牌 TTL 天数' },
            {
              name: 'newapiUsageSource',
              type: 'select',
              label: '用量来源',
              options: [
                { label: 'New API 日志', value: 'newapi' },
                { label: '本地流水估算', value: 'local' },
              ],
            },
            {
              name: 'newapiLogScope',
              type: 'select',
              label: '日志口径',
              options: [
                { label: '自动', value: 'auto' },
                { label: 'Admin /api/log', value: 'admin' },
                { label: 'Self /api/log/self', value: 'self' },
              ],
            },
            { name: 'newapiMarginRate', type: 'number', label: 'local 估算毛利率' },
            { name: 'newapiModelMarginRates', type: 'textarea', label: '模型毛利率 dry-run 对照' },
            { name: 'newapiReconcileToleranceCents', type: 'number', label: '对账容忍漂移（分）' },
            { name: 'newapiUsdExchangeRateCny', type: 'number', label: 'USD/CNY fallback 汇率' },
            { name: 'allowLocalMarginExchange', type: 'checkbox', label: '允许 local 毛利估算写回兑换池' },
          ],
        },
        {
          label: '签名与备份',
          fields: [
            {
              name: 'signingKeyEncrypted',
              type: 'textarea',
              label: 'Manifest 签名私钥（保存后显示密文）',
              admin: { description: 'ed25519 PKCS8 base64；可用 npm run keygen 生成，保存时自动加密。' },
            },
            { name: 'backupEncryptionConfirmed', type: 'checkbox', label: '已确认备份加密' },
            { name: 'backupOffsiteConfirmed', type: 'checkbox', label: '已确认离机/异地备份' },
            { name: 'backupRestoreDrillAt', type: 'date', label: '最近恢复演练日期' },
            { name: 'backupNotes', type: 'textarea', label: '备份备注' },
          ],
        },
        {
          label: '可信网络',
          fields: [
            {
              name: 'anchorTrustedPublishers',
              type: 'textarea',
              label: '外锚可信发布目标',
              admin: {
                description: '逗号分隔；格式 target|urlPrefix 或 urlPrefix。用于 /v1/anchors/verify 判断 publishedTo 是否命中可信网络。',
              },
            },
          ],
        },
      ],
    },
  ],
  hooks: {
    beforeChange: [
      ({ data }) => normalizeDeploymentSecretFields(data),
    ],
  },
}
