/// <reference types="vite/client" />

// preload 通过 contextBridge 暴露的 API；类型直接取自 preload 实现，避免两处手写漂移
declare global {
  interface Window {
    api: import('../../preload').Api
  }
}

export {}
