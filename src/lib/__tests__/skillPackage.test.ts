import { describe, expect, it } from 'vitest'
import { buildSkillComplianceReviewPrompt, packageStatusForReview } from '@/lib/skillComplianceReview'
import { analyzeSkillPackage } from '@/lib/skillPackage'

function u16(n: number) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

function zipStore(files: Record<string, string>) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const bodyBuf = Buffer.from(body)
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(bodyBuf.length),
      u32(bodyBuf.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      bodyBuf,
    ])
    locals.push(local)
    centrals.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(bodyBuf.length),
      u32(bodyBuf.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]))
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...locals, central, eocd])
}

const manifest = `schema_version: hengshu.skill/v1
name: 测试 Skill
version: 1.0.0
runtime:
  type: prompt
  min_runner_version: 0.2.0
permissions:
  network: false
  file_read: false
  file_write: false
  shell: false
prompt:
  system: 你是助手
  user_template: "请回答：{{topic}}"
input_schema:
  topic:
    type: string
    label: 主题
    required: true
`

describe('skill package analysis', () => {
  it('extracts manifest and prompt from a zip package', () => {
    const pkg = zipStore({
      'hengshu.skill.yaml': manifest,
      'README.md': '# 测试 Skill\n用于测试。',
    })
    const analysis = analyzeSkillPackage('skill.zip', pkg)
    expect(analysis.manifestName).toBe('hengshu.skill.yaml')
    expect(analysis.promptTemplate).toContain('{{topic}}')
    expect(analysis.inputSchema.topic.label).toBe('主题')
    expect(analysis.issues.filter((i) => i.level === 'blocker')).toHaveLength(0)
  })

  it('blocks packages containing secret files', () => {
    const pkg = zipStore({
      'hengshu.skill.yaml': manifest,
      '.env': 'MODEL_GATEWAY_KEY=secret',
    })
    const analysis = analyzeSkillPackage('skill.zip', pkg)
    expect(analysis.issues.some((i) => i.code === 'SECRET_FILE_INCLUDED' && i.level === 'blocker')).toBe(true)
  })

  it('requires hengshu.skill.yaml', () => {
    const pkg = zipStore({ 'README.md': '# only readme' })
    const analysis = analyzeSkillPackage('skill.zip', pkg)
    expect(analysis.issues.some((i) => i.code === 'MANIFEST_MISSING' && i.level === 'blocker')).toBe(true)
  })

  it('uses the compliance-review skill prompt for package review context', () => {
    const pkg = zipStore({
      'hengshu.skill.yaml': manifest,
      'README.md': '# 测试 Skill\n用于测试。',
    })
    const analysis = analyzeSkillPackage('skill.zip', pkg)
    const prompt = buildSkillComplianceReviewPrompt({ title: '测试 Skill', category: 'AI 评测', analysis })
    expect(prompt).toContain('Skill 安全')
    expect(prompt).toContain('hengshu.skill.yaml')
    expect(prompt).toContain('测试 Skill')
  })

  it('only publishes AI-approved packages; all non-approve decisions stay pending for staff review', () => {
    expect(packageStatusForReview({ decision: 'approve' })).toBe('published')
    expect(packageStatusForReview({ decision: 'manual_review' })).toBe('pending')
    expect(packageStatusForReview({ decision: 'reject' })).toBe('pending')
  })
})
