import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'

const ENC_PREFIX = 'enc:v1:'

export function serverSecret(): string {
  const secret = process.env.PAYLOAD_SECRET || ''
  if (secret.length >= 16) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PAYLOAD_SECRET 必须在生产环境配置为强随机值')
  }
  return 'gewu-dev-secret'
}

function secretKey(): Buffer {
  return createHash('sha256').update(serverSecret()).digest()
}

export function hmacDigest(value: string, purpose: string, length = 64): string {
  if (!value) return ''
  return createHmac('sha256', serverSecret())
    .update(purpose)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, length)
}

export function encryptSecret(plain: string | null | undefined): string | null {
  const value = String(plain || '').trim()
  if (!value) return null
  if (value.startsWith(ENC_PREFIX)) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptSecret(stored: string | null | undefined): string {
  const value = String(stored || '').trim()
  if (!value) return ''
  // 兼容旧数据：历史上字段名虽叫 encrypted，但实际为明文。
  if (!value.startsWith(ENC_PREFIX)) return value
  try {
    const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split('.')
    if (!ivB64 || !tagB64 || !dataB64) return ''
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivB64, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}


export function encryptJsonSecret(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'object' && value && typeof (value as any).__enc === 'string') return value
  return { __enc: encryptSecret(JSON.stringify(value)) }
}

export function decryptJsonSecret(value: unknown): unknown {
  if (!value || typeof value !== 'object' || typeof (value as any).__enc !== 'string') return value
  const plain = decryptSecret((value as any).__enc)
  if (!plain) return null
  try {
    return JSON.parse(plain)
  } catch {
    return null
  }
}
