import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateKeyPairSync, createPublicKey, verify as edVerify } from 'crypto'
import { canonicalString } from '@/lib/canonical'

// 信任模型一致性：manifest 用 ed25519 签名，Runner/前台用 /v1/keys 公钥验签。
// 此测试端到端验证「signCanonical 产出可被 getPublicKeyInfo 公钥验签通过」，并锁死规范化一致性。
let signing: typeof import('@/lib/signing')

beforeAll(async () => {
  // 生成临时 ed25519 私钥注入 env（模块 privKey 懒加载，import 前置 env 即可）
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  process.env.GEWU_SIGNING_KEY = der.toString('base64')
  process.env.PAYLOAD_SECRET = 'test-secret'
  signing = await import('@/lib/signing')
})

function pubKey() {
  const info = signing.getPublicKeyInfo()!
  return createPublicKey({ key: Buffer.from(info.publicKey, 'base64'), format: 'der', type: 'spki' })
}

describe('signing 往返（信任模型一致性）', () => {
  it('签名可被发布的公钥验签通过', () => {
    const core = { b: 1, a: 2, nested: { y: 1, x: 2 } }
    const sig = signing.signCanonical(core)
    expect(sig).toBeTruthy()
    const info = signing.getPublicKeyInfo()!
    expect(info.algorithm).toBe('ed25519')
    const ok = edVerify(null, Buffer.from(canonicalString(core), 'utf8'), pubKey(), Buffer.from(sig!, 'base64'))
    expect(ok).toBe(true)
  })

  it('key 顺序不同的等价 core 验签仍通过（规范化保证跨端一致）', () => {
    const sig = signing.signCanonical({ a: 2, b: 1 })!
    const ok = edVerify(
      null,
      Buffer.from(canonicalString({ b: 1, a: 2 }), 'utf8'),
      pubKey(),
      Buffer.from(sig, 'base64'),
    )
    expect(ok).toBe(true)
  })

  it('篡改内容 → 验签失败', () => {
    const sig = signing.signCanonical({ a: 1 })!
    const ok = edVerify(
      null,
      Buffer.from(canonicalString({ a: 2 }), 'utf8'),
      pubKey(),
      Buffer.from(sig, 'base64'),
    )
    expect(ok).toBe(false)
  })

  it('keyId 稳定（signCanonical 与 publicKeyInfo 同源）', () => {
    expect(signing.getSigningKeyId()).toBe(signing.getPublicKeyInfo()!.keyId)
  })

  it('无签名密钥时优雅降级为 null（不抛错）', async () => {
    vi.resetModules()
    const saved = process.env.GEWU_SIGNING_KEY
    delete process.env.GEWU_SIGNING_KEY
    const fresh = await import('@/lib/signing')
    expect(fresh.signCanonical({ a: 1 })).toBeNull()
    expect(fresh.getPublicKeyInfo()).toBeNull()
    process.env.GEWU_SIGNING_KEY = saved
    vi.resetModules()
  })
})
