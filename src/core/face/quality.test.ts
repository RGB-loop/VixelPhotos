import { describe, it, expect } from 'vitest'
import { faceQuality, laplacianVariance } from './quality'

const SIZE = 112
function image(fn: (x: number, y: number) => number): Buffer {
  const b = Buffer.alloc(SIZE * SIZE * 3)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const v = fn(x, y)
    b.fill(v, (y * SIZE + x) * 3, (y * SIZE + x) * 3 + 3)
  }
  return b
}
const sharp = image((x, y) => ((x >> 2) + (y >> 2)) % 2 ? 255 : 0)
const flat = image(() => 128)
// 正脸关键点（归一化）：左眼、右眼、鼻尖、左嘴角、右嘴角
const frontal: [number, number][] = [[0.4, 0.4], [0.6, 0.4], [0.5, 0.5], [0.42, 0.6], [0.58, 0.6]]
const profile: [number, number][] = [[0.4, 0.4], [0.6, 0.4], [0.62, 0.5], [0.5, 0.6], [0.6, 0.6]]

describe('laplacianVariance', () => {
  it('is zero for a flat image and large for a checkerboard', () => {
    expect(laplacianVariance(flat)).toBe(0)
    expect(laplacianVariance(sharp)).toBeGreaterThan(1000)
  })
})

describe('faceQuality', () => {
  const bbox = { w: 0.2, h: 0.25 }
  it('scores a large sharp frontal face high', () => {
    const q = faceQuality(bbox, frontal, 1000, 1000, sharp)
    expect(q.yaw).toBeCloseTo(0, 5)
    expect(q.score).toBe(1)
  })
  it('penalises tiny, blurry and profile faces', () => {
    expect(faceQuality({ w: 0.02, h: 0.02 }, frontal, 1000, 1000, sharp).score).toBe(0)
    expect(faceQuality(bbox, frontal, 1000, 1000, flat).score).toBe(0)
    const side = faceQuality(bbox, profile, 1000, 1000, sharp)
    expect(side.yaw).toBeGreaterThan(0.5)
    expect(side.score).toBeLessThan(0.2)
  })
})
