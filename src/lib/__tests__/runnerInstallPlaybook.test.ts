import { describe, expect, it } from 'vitest'
import { runnerInstallPlaybook } from '@/lib/runnerInstallPlaybook'

describe('runnerInstallPlaybook — Runner 安装验签回流指引', () => {
  it('给出验签、本地运行、回流和更新路径', () => {
    const playbook = runnerInstallPlaybook({
      slug: 'writer',
      version: '1.2.0',
      checksum: 'sha256:abc',
      signed: true,
    })

    expect(playbook).toMatchObject({
      customerValue: expect.stringContaining('本地可信运行闭环'),
      decision: 'install_and_report',
      installScope: {
        slug: 'writer',
        version: '1.2.0',
        checksum: 'sha256:abc',
        requiresSignedManifest: true,
      },
      nextActions: expect.arrayContaining([
        expect.objectContaining({ label: '校验 manifest', href: '/v1/keys' }),
        expect.objectContaining({ label: '本地运行', href: '/v1/skills/writer/manifest' }),
        expect.objectContaining({ label: '回传兼容报告', href: '/v1/runner/report' }),
        expect.objectContaining({ label: '保持版本新鲜', href: '/v1/runner/check' }),
      ]),
    })
  })

  it('不会把 Runner token 或 API Key 放进公开指引', () => {
    const text = JSON.stringify(runnerInstallPlaybook({ slug: 'private skill', signed: false }))
    expect(text).not.toMatch(/runner-token|access_token|sk-/i)
    expect(text).toContain('/v1/skills/private%20skill/manifest')
    expect(runnerInstallPlaybook({ signed: false }).decision).toBe('verify_before_install')
  })
})
