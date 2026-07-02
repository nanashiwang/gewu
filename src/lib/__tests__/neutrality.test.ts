import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// 中立四面墙·数学隔离(总纲 §3.3-1 / 6j)：排名/评测函数的实现里不得出现平台收益字段，
// 从代码层物理保证"排名不被变现稀释"——人事后想改也会被此断言(跑在 CI 里)挡红。
// 这是可验证中立承诺的第一块地基；"中立历史长度"从本断言落地日开始计时。
const FORBIDDEN = /\b(margin|isOurs|isOwn|revenue|profit|markup)\b/i
const RANK_FILES = ['src/lib/skillrank.ts', 'src/lib/modelrank.ts']

describe('中立四面墙·数学隔离(6j)：排名代码不得含 margin/isOurs 等收益字段', () => {
  for (const rel of RANK_FILES) {
    it(`${rel} 无平台收益字段`, () => {
      const abs = resolve(process.cwd(), rel)
      if (!existsSync(abs)) return // modelrank 尚未建(阶段1 #12)，建后此断言自动生效
      const src = readFileSync(abs, 'utf8')
      // 剥离注释行，避免注释里提及 margin 造成误伤
      const code = src
        .split('\n')
        .filter((l) => {
          const t = l.trim()
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
        })
        .join('\n')
      const m = code.match(FORBIDDEN)
      expect(m ? `${rel} 含禁用收益字段: ${m[0]}` : null).toBeNull()
    })
  }
})
