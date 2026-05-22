import { describe, it, expect } from 'vitest'
import { dot, l2Distance, l2Normalize, l2ToCosineDistance } from './distance'

const NEAR = 1e-6

describe('l2ToCosineDistance — formula sanity', () => {
  it('identical unit vectors: L2 = 0 → cos_distance = 0', () => {
    expect(l2ToCosineDistance(0)).toBeCloseTo(0, 12)
  })

  it('orthogonal unit vectors: L2 = √2 → cos_distance = 1', () => {
    const a = l2Normalize(new Float32Array([1, 0, 0]))
    const b = l2Normalize(new Float32Array([0, 1, 0]))
    const observed = l2Distance(a, b)
    expect(observed).toBeCloseTo(Math.SQRT2, 5)
    expect(l2ToCosineDistance(observed)).toBeCloseTo(1, 5)
    // 双重验证：1 - dot 应该等于 cos_distance
    expect(1 - dot(a, b)).toBeCloseTo(1, 5)
  })

  it('antipodal unit vectors: L2 = 2 → cos_distance = 2', () => {
    const a = l2Normalize(new Float32Array([1, 0, 0]))
    const b = l2Normalize(new Float32Array([-1, 0, 0]))
    expect(l2Distance(a, b)).toBeCloseTo(2, 5)
    expect(l2ToCosineDistance(2)).toBeCloseTo(2, 12)
    expect(1 - dot(a, b)).toBeCloseTo(2, 5)
  })

  it('formula matches 1 - cos at known angles', () => {
    // 60° 夹角：cos = 0.5
    const a = l2Normalize(new Float32Array([1, 0]))
    const b = l2Normalize(new Float32Array([Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)]))
    const cosA = dot(a, b)
    const cosDist = 1 - cosA
    const fromL2 = l2ToCosineDistance(l2Distance(a, b))
    expect(fromL2).toBeCloseTo(cosDist, 5)
  })

  it('threshold check: distance < MAX_DISTANCE (0.6) maps to L2 < ~1.095', () => {
    // 项目里 face/index.ts 的 MAX_DISTANCE = 0.6 (cosine)
    // 对应 L2 = sqrt(2 * 0.6) ≈ 1.0954
    const equivalentL2 = Math.sqrt(2 * 0.6)
    expect(l2ToCosineDistance(equivalentL2)).toBeCloseTo(0.6, 5)
  })
})

describe('l2Normalize', () => {
  it('returns unit-length vector', () => {
    const v = l2Normalize(new Float32Array([3, 4]))
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1])
    expect(len).toBeCloseTo(1, 5)
    expect(v[0]).toBeCloseTo(0.6, 5)
    expect(v[1]).toBeCloseTo(0.8, 5)
  })

  it('handles zero vector without crashing', () => {
    const v = l2Normalize(new Float32Array([0, 0, 0]))
    expect(v).toEqual(new Float32Array([0, 0, 0]))
  })
})

describe('dot / l2Distance shape tolerance', () => {
  it('takes the shorter length when arrays differ', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([1, 0])
    // Only the overlapping prefix is considered; difference along missing
    // dimension is treated as 0. This matches assignFaceToPerson's
    // bruteForceNearest behavior (which we want to keep deterministic).
    expect(dot(a, b)).toBeCloseTo(1, 5)
    expect(l2Distance(a, b)).toBeCloseTo(0, 5)
    void NEAR
  })
})
