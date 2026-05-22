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

  it('classifies only HEIC/HEIF as heic-convert formats (RAW does not go through libheif)', () => {
    expect(__internal.isHeicConvertFormat('.heic')).toBe(true)
    expect(__internal.isHeicConvertFormat('.HEIF')).toBe(true)
    for (const ext of ['.cr2', '.nef', '.arw', '.dng', '.raf']) {
      expect(__internal.isHeicConvertFormat(ext)).toBe(false)
    }
  })

  it('supportedFallbacks: HEIC has both paths on macOS, only heic-convert on Linux/Win', () => {
    const heicFallbacks = __internal.supportedFallbacks('.heic')
    if (process.platform === 'darwin') {
      // sips 比 heic-convert 快，应排第一
      expect(heicFallbacks).toEqual(['sips', 'heic-convert'])
    } else {
      expect(heicFallbacks).toEqual(['heic-convert'])
    }
  })

  it('supportedFallbacks: RAW only has sips path on macOS, empty on Linux/Win', () => {
    const cr2Fallbacks = __internal.supportedFallbacks('.cr2')
    if (process.platform === 'darwin') {
      expect(cr2Fallbacks).toEqual(['sips'])
    } else {
      expect(cr2Fallbacks).toEqual([])
    }
  })

  it('supportedFallbacks: formats sharp handles directly need no fallback', () => {
    for (const ext of ['.jpg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.avif']) {
      expect(__internal.supportedFallbacks(ext)).toEqual([])
    }
  })
})
