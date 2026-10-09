import { describe, it, expect } from 'vitest'
import {
  clusterFaces, suggestMerges, pairKey, dotF,
  type ClusterInput, type DormantNeighbor, type PendingFace, type PersonCentroid,
} from './cluster'

const DIM = 64

/** 可复现的随机单位向量 */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
}
function unit(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n)
  return v.map((x) => x / n)
}
function identity(seed: number): Float32Array {
  const r = rng(seed)
  return unit(Float32Array.from({ length: DIM }, r))
}
/** 身份向量 + 随机方向 × noise：与身份相似度约 1/√(1+noise²)，同身份两张约 1/(1+noise²) */
function sample(base: Float32Array, seed: number, noise = 0.8): Float32Array {
  const dir = identity(seed * 7919)
  return unit(base.map((x, i) => x + dir[i] * noise))
}

let nextId = 1
const face = (emb: Float32Array, quality = 0.9): PendingFace => ({ id: nextId++, embedding: emb, quality })

function input(partial: Partial<ClusterInput>, dormantPool: PendingFace[] = []): ClusterInput {
  return {
    persons: [],
    pending: [],
    rejections: new Map(),
    dismissedPairs: new Set(),
    knnDormant: (vec, k) =>
      dormantPool
        .map((f): DormantNeighbor => ({ ...f, sim: dotF(vec, f.embedding) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k),
    ...partial,
  }
}

const A = identity(11), B = identity(22), C = identity(33)

describe('clusterFaces', () => {
  it('groups new faces of the same identity and keeps identities apart', async () => {
    const fa = [1, 2, 3, 4].map((s) => face(sample(A, s)))
    const fb = [5, 6, 7].map((s) => face(sample(B, s)))
    const plan = await clusterFaces(input({ pending: [...fa, ...fb] }))
    expect(plan.create).toHaveLength(2)
    const groups = plan.create.map((g) => new Set(g))
    const ga = groups.find((g) => g.has(fa[0].id))!
    expect([...ga].sort()).toEqual(fa.map((f) => f.id).sort())
    expect(groups.find((g) => g.has(fb[0].id))!.size).toBe(3)
    expect(plan.dormant).toHaveLength(0)
  })

  it('assigns to an existing person and leaves singletons dormant', async () => {
    const persons: PersonCentroid[] = [{ id: 100, named: true, centroid: A, count: 5 }]
    const fa = face(sample(A, 9))
    const lone = face(sample(C, 9))
    const plan = await clusterFaces(input({ persons, pending: [fa, lone] }))
    expect(plan.assign).toEqual([{ faceId: fa.id, personId: 100 }])
    expect(plan.create).toHaveLength(0)
    expect(plan.dormant).toEqual([lone.id])
  })

  it('never seeds a person from low-quality faces', async () => {
    const blurry = [1, 2, 3].map((s) => face(sample(C, s), 0.2))
    const plan = await clusterFaces(input({ pending: blurry }))
    expect(plan.create).toHaveLength(0)
    expect(plan.dormant.sort()).toEqual(blurry.map((f) => f.id).sort())
  })

  it('pulls a matching dormant face into a new cluster', async () => {
    const old = face(sample(B, 40))
    const fresh = face(sample(B, 41))
    const plan = await clusterFaces(input({ pending: [fresh] }, [old]))
    expect(plan.create).toHaveLength(1)
    expect(new Set(plan.create[0])).toEqual(new Set([fresh.id, old.id]))
  })

  it('respects "not this person" rejections', async () => {
    const persons: PersonCentroid[] = [{ id: 100, named: true, centroid: A, count: 5 }]
    const fa = face(sample(A, 50))
    const plan = await clusterFaces(input({ persons, pending: [fa], rejections: new Map([[fa.id, new Set([100])]]) }))
    expect(plan.assign).toHaveLength(0)
  })

  it('merges an unnamed duplicate into a named person but never two named people', async () => {
    const dupA = sample(A, 60, 0.2)
    const persons: PersonCentroid[] = [
      { id: 1, named: true, centroid: A, count: 10 },
      { id: 2, named: false, centroid: dupA, count: 3 },
      { id: 3, named: true, centroid: sample(A, 61, 0.2), count: 4 },
    ]
    // 新脸让 2 变 dirty，触发合并检查
    const plan = await clusterFaces(input({ persons, pending: [face(sample(A, 62, 0.2))] }))
    expect(plan.merges.some((m) => m.from === 2)).toBe(true)
    expect(plan.merges.every((m) => !(m.from === 1 && m.into === 3) && !(m.from === 3 && m.into === 1))).toBe(true)
  })

  it('skips dismissed pairs', async () => {
    const persons: PersonCentroid[] = [
      { id: 1, named: false, centroid: A, count: 10 },
      { id: 2, named: false, centroid: sample(A, 70, 0.2), count: 3 },
    ]
    const plan = await clusterFaces(input({
      persons, pending: [face(sample(A, 71, 0.2))], dismissedPairs: new Set([pairKey(1, 2)]),
    }))
    expect(plan.merges).toHaveLength(0)
  })
})

describe('suggestMerges', () => {
  it('suggests mid-similarity pairs only, named person first, skipping dismissed and named pairs', () => {
    // 构造相似度约 0.5 的一对
    const mid = unit(A.map((x, i) => x + C[i]))
    const persons: PersonCentroid[] = [
      { id: 1, named: false, centroid: mid, count: 3 },
      { id: 2, named: true, centroid: A, count: 3 },
      { id: 3, named: true, centroid: C, count: 3 },
      { id: 4, named: false, centroid: B, count: 3 },
    ]
    const out = suggestMerges(persons, new Set())
    expect(out.map((s) => [s.a, s.b])).toEqual(expect.arrayContaining([[2, 1], [3, 1]]))
    expect(out.every((s) => s.b !== 4 && s.a !== 4)).toBe(true)
    expect(suggestMerges(persons, new Set([pairKey(1, 2), pairKey(1, 3)]))).toHaveLength(0)
  })
})
