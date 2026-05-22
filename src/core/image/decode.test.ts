import { describe, it, expect } from 'vitest'
import { __internal } from './decode'

describe('decodeImage routing logic', () => {
  it('classifies HEIC variants as sips fallback formats', () => {
    expect(__internal.isSipsFallbackFormat('.heic')).toBe(true)
    expect(__internal.isSipsFallbackFormat('.HEIC')).toBe(true)
    expect(__internal.isSipsFallbackFormat('.heif')).toBe(true)
  })

  it('classifies common RAW extensions as sips fallback formats', () => {
    for (const ext of ['.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2']) {
      expect(__internal.isSipsFallbackFormat(ext)).toBe(true)
    }
  })

  it('does NOT route formats sharp handles directly through sips', () => {
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.avif']) {
      expect(__internal.isSipsFallbackFormat(ext)).toBe(false)
    }
  })

  it('platform RAW support is darwin-only for v0.2', () => {
    // 当前进程 platform 在 CI matrix 上可能是 darwin 或 linux；
    // 只检查 helper 与实际 platform 一致，不硬编码期望值
    expect(__internal.isPlatformSupportedForRaw()).toBe(process.platform === 'darwin')
  })
})
