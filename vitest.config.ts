import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// 单测配置：node 环境（被测均为纯函数/crypto，无需 DOM）；解析 @/ 别名到 src。
export default defineConfig({
  resolve: {
    alias: {
      '@payload-config': resolve(__dirname, './src/payload.config.ts'),
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'runner/**/*.{test,spec}.mjs'],
    globals: false,
  },
})
