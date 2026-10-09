import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // inference：推理 utilityProcess 的入口（见 src/main/inference.ts）
        input: {
          index: resolve('src/main/index.ts'),
          inference: resolve('src/main/inference.ts')
        },
        external: ['better-sqlite3', 'sharp', 'onnxruntime-node', 'sqlite-vec']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
