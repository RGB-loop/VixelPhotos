import { describe, it, expect } from 'vitest'
import { fitSimilarity, alignFace, ALIGNED_SIZE } from './alignment'

const REF: [number, number][] = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041],
]

describe('fitSimilarity', () => {
  it('recovers a rotation + scale + translation exactly', () => {
    const t = (x: number, y: number): [number, number] => {
      const a = 2.5 * Math.cos(0.4), b = 2.5 * Math.sin(0.4)
      return [a * x - b * y + 300, b * x + a * y + 120]
    }
    const map = fitSimilarity(REF, REF.map(([x, y]) => t(x, y)))
    for (const [x, y] of [[0, 0], [111, 0], [56, 56], [10, 100]] as const) {
      const [u, v] = map(x, y)
      const [eu, ev] = t(x, y)
      expect(u).toBeCloseTo(eu, 6)
      expect(v).toBeCloseTo(ev, 6)
    }
  })
})

describe('alignFace', () => {
  // 一张 400×300 图：每个像素的 R/G 编码自身坐标，便于检查采样落点
  const W = 400, H = 300
  const data = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3
    data[o] = x % 256; data[o + 1] = y % 256; data[o + 2] = 128
  }
  const img = { data, width: W, height: H }

  it('outputs a 112×112 RGB crop (not the whole image, not black)', () => {
    // 人脸放在 (100,80) 起、放大 1.5 倍
    const lm = REF.map(([x, y]) => [(100 + 1.5 * x) / W, (80 + 1.5 * y) / H] as [number, number])
    const out = alignFace(img, lm)
    expect(out.length).toBe(ALIGNED_SIZE * ALIGNED_SIZE * 3)
    // 输出 (0,0) 应采样到原图 (100,80)，(111,111) 应到 (266.5,246.5)（R 按 256 取模）
    expect(out[0]).toBe(100); expect(out[1]).toBe(80)
    const last = (111 * ALIGNED_SIZE + 111) * 3
    expect(Math.abs(out[last] - (266.5 - 256))).toBeLessThanOrEqual(1)
    expect(Math.abs(out[last + 1] - 246.5)).toBeLessThanOrEqual(1)
  })

  it('mirror flips horizontally', () => {
    const lm = REF.map(([x, y]) => [(100 + x) / W, (80 + y) / H] as [number, number])
    const a = alignFace(img, lm), b = alignFace(img, lm, true)
    const row = 40
    expect(b[(row * ALIGNED_SIZE) * 3]).toBe(a[(row * ALIGNED_SIZE + 111) * 3])
  })

  it('fills out-of-bounds with black instead of throwing', () => {
    const lm = REF.map(([x, y]) => [(x - 60) / W, (y - 60) / H] as [number, number])
    const out = alignFace(img, lm)
    expect(out[0]).toBe(0)
  })
})
