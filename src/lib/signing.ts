import { createPrivateKey, createPublicKey, sign as edSign, createHash, type KeyObject } from 'crypto'
import { canonicalString } from './canonical'

let _priv: KeyObject | null | undefined
let _kid: string | null = null

type Env = Record<string, string | undefined>

function parsePrivKey(value?: string): KeyObject | null {
  const b64 = value?.trim()
  if (!b64) return null
  try {
    return createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    return null
  }
}

function privKey(env: Env = process.env): KeyObject | null {
  if (env !== process.env) return parsePrivKey(env.HENGSHU_SIGNING_KEY)
  if (_priv !== undefined) return _priv
  _priv = parsePrivKey(process.env.HENGSHU_SIGNING_KEY)
  return _priv
}

function keyIdFor(k: KeyObject): string {
  const pub = createPublicKey(k).export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(pub as Buffer).digest('hex').slice(0, 12)
}

// 对规范化后的 core 做 ed25519 签名，返回 base64；无私钥则返回 null
export function signCanonical(core: any, env: Env = process.env): string | null {
  const k = privKey(env)
  if (!k) return null
  try {
    return edSign(null, Buffer.from(canonicalString(core), 'utf8'), k).toString('base64')
  } catch {
    return null
  }
}

export function getSigningKeyId(env: Env = process.env): string | null {
  const k = privKey(env)
  if (!k) return null
  if (env !== process.env) return keyIdFor(k)
  if (_kid) return _kid
  _kid = keyIdFor(k)
  return _kid
}

export function getPublicKeyInfo(env: Env = process.env): { keyId: string; algorithm: string; publicKey: string } | null {
  const k = privKey(env)
  if (!k) return null
  const pubDer = createPublicKey(k).export({ format: 'der', type: 'spki' }) as Buffer
  return {
    keyId: getSigningKeyId(env) as string,
    algorithm: 'ed25519',
    publicKey: pubDer.toString('base64'),
  }
}
