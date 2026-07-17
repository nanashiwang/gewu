import { createPublicKey, generateKeyPairSync, verify as edVerify } from 'crypto'
import { describe, expect, it } from 'vitest'
import { canonicalString } from '@/lib/canonical'
import { buildManifest, manifestToJson, manifestToYaml } from '@/lib/manifest'

function signingEnv() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  return { GEWU_SIGNING_KEY: der.toString('base64') }
}

const skill = {
  slug: 'title-maker',
  title: '标题生成器',
  description: '生成标题',
  author: { username: 'alice' },
  category: { slug: 'writing' },
}

const version = {
  version: '1.0.0',
  license: 'MIT',
  minRunnerVersion: '0.2.0',
  permissions: { network: false, fileRead: false, fileWrite: false, shell: false },
  inputSchema: { topic: { type: 'string', required: true } },
  outputSchema: { title: { type: 'string' } },
  systemPrompt: '你是标题助手',
  promptTemplate: '主题：{{topic}}',
  recommendedModels: { local: ['qwen2.5:14b'] },
  examples: [{ input: { topic: 'AI' }, output: { title: 'AI 标题' } }],
}

describe('manifest — 确定性 checksum 与 ed25519 签名', () => {
  it('同一 SkillVersion 多次生成 checksum/签名稳定，且不含导出时间戳', () => {
    const env = signingEnv()
    const first = buildManifest(skill, version, { siteUrl: 'https://gewu.example', env })
    const second = buildManifest(skill, version, { siteUrl: 'https://gewu.example', env })

    expect(first.integrity).toEqual(second.integrity)
    expect(first.integrity.checksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(first.integrity.signature).toBeTruthy()
    expect(JSON.stringify(first)).not.toContain('exported_at')
    expect(manifestToYaml(first)).toBe(manifestToYaml(second))
    expect(manifestToJson(first)).toBe(manifestToJson(second))
  })

  it('checksum 只覆盖 core，签名可用公开 key 对 canonical core 验证', async () => {
    const env = signingEnv()
    const manifest = buildManifest(skill, version, { env })
    const { integrity, ...core } = manifest
    const signing = await import('@/lib/signing')
    const publicInfo = signing.getPublicKeyInfo(env)!
    const publicKey = createPublicKey({ key: Buffer.from(publicInfo.publicKey, 'base64'), format: 'der', type: 'spki' })

    expect(integrity.keyId).toBe(publicInfo.keyId)
    expect(edVerify(null, Buffer.from(canonicalString(core), 'utf8'), publicKey, Buffer.from(integrity.signature, 'base64'))).toBe(true)
  })
})
