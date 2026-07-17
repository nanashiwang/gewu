import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeSkillSlug, resolveSkillDir } from './pathSafety.mjs'

describe('runner path safety', () => {
  it('accepts canonical ASCII and Chinese slugs', () => {
    expect(normalizeSkillSlug(' Writer.Skill_v1 ')).toBe('writer.skill_v1')
    expect(normalizeSkillSlug('中文-skill')).toBe('中文-skill')
  })

  it.each([
    '',
    '.',
    '..',
    '../..',
    '..\\..',
    '/tmp/escape',
    'C:\\temp',
    'writer/escape',
    'writer\\escape',
    'writer%2fescape',
    '-leading',
    'trailing-',
    'CON',
    'com1.txt',
  ])('rejects adversarial slug %j', (slug) => {
    expect(() => normalizeSkillSlug(slug)).toThrow(/slug|路径|保留名/i)
  })

  it('keeps every resolved directory inside the skills root', () => {
    const root = path.resolve('C:/Users/demo/.gewu/skills')
    const target = resolveSkillDir(root, 'safe-skill')
    expect(path.relative(root, target)).toBe('safe-skill')
    expect(() => resolveSkillDir(root, '../..')).toThrow()
  })
})
