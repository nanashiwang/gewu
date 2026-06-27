import { createPrivateKey, createPublicKey, sign as edSign, createHash, type KeyObject } from 'crypto'
import { canonicalString } from './canonical'

let _priv: KeyObject | null | undefined
let _kid: string | null = null

function privKey(): KeyObject | null {
  if (_priv !== undefined) return _priv
  const b64 = process.env.HENGSHU_SIGNING_KEY
  if (!b64) {
    _priv = null
    return null
  }
  try {
    _priv = createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    _priv = null
  }
  return _priv
}

// 对规范化后的 core 做 ed25519 签名，返回 base64；无私钥则返回 null
export function signCanonical(core: any): string | null {
  const k = privKey()
  if (!k) return null
  try {
    return edSign(null, Buffer.from(canonicalString(core), 'utf8'), k).toString('base64')
  } catch {
    return null
  }
}

export function getSigningKeyId(): string | null {
  const k = privKey()
  if (!k) return null
  if (_kid) return _kid
  const pub = createPublicKey(k).export({ format: 'der', type: 'spki' })
  _kid = createHash('sha256').update(pub as Buffer).digest('hex').slice(0, 12)
  return _kid
}

export function getPublicKeyInfo(): { keyId: string; algorithm: string; publicKey: string } | null {
  const k = privKey()
  if (!k) return null
  const pubDer = createPublicKey(k).export({ format: 'der', type: 'spki' }) as Buffer
  return {
    keyId: getSigningKeyId() as string,
    algorithm: 'ed25519',
    publicKey: pubDer.toString('base64'),
  }
}
