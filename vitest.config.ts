import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只跑 src 下的测试，绕开 node_modules 与 electron 打包产物
    include: ['src/**/*.{test,spec}.ts'],
    // 主进程代码以 node 环境跑（不需要 electron）
    environment: 'node',
    // 别启用全局，import 显式更清晰
    globals: false,
  },
})
