/**
 * 人物聚类（批量）：把"还没归属"的人脸整理成人物。纯函数，不碰数据库，方便单测。
 *
 * 思路取自 Apple Photos / Immich：宁可漏归，不可错归。
 *   1. 新脸按质量从高到低，依次和"人物质心"比（现有人物 + 本批临时簇），
 *      够近就归入；不够近且质量够好就自己开一个临时簇（并顺带拉回 KNN 里够近的旧落单脸）。
 *      低质量脸（糊 / 小 / 侧脸）不开新簇，只在很确定时并入现有人物。
 *   2. 合并：质心足够近的两簇合并。两个已命名人物永远不自动合并；
 *      未命名 → 已命名要求更高阈值；有"不是此人"约束 / 用户驳回过的组合跳过。
 *   3. 质心更新后，再从落单脸里 KNN 拉一次（新人物出现后，旧落单脸可能就有归宿了）。
 *   4. 少于 MIN_FACES 的临时簇解散，脸留着等以后的批次。
 *
 * 已归属的脸不在这里移动 —— 已命名人物天然"锁定"，用户的手动整理不会被推翻。
 *
 * 阈值（w600k_mbf + 本仓库对齐流程，LFW 标定，余弦相似度）：
 *   脸↔本人质心 p1 0.57，脸↔他人质心 max 0.26；同一人两半质心 ≥ 0.86，不同人质心 ≤ 0.15。
 *   真实相册里有家人、小孩、暗光，留足余量。
 */

export const T_ASSIGN = 0.45        // 脸 → 质心：归入
export const T_ASSIGN_LOWQ = 0.52   // 低质量脸要更确定
export const T_LINK = 0.5           // 脸 ↔ 脸：拉回落单脸 / 开簇时的邻居
export const T_MERGE = 0.6          // 质心 ↔ 质心：未命名之间自动合并
export const T_MERGE_NAMED = 0.7    // 未命名 → 已命名
export const T_SUGGEST = 0.4        // ≥ 此值、仍是两个人物的进"是同一个人吗？"
export const Q_SEED = 0.4           // 质量 ≥ 此值才能开新簇
export const Q_MIN = 0.12           // 低于此值不参与自动聚类
export const MIN_FACES = 2          // 临时簇至少几张脸才成为人物

export interface PersonCentroid {
  id: number
  named: boolean
  /** 已 L2 归一化 */
  centroid: Float32Array
  count: number
}

export interface PendingFace {
  id: number
  embedding: Float32Array
  quality: number
}

export interface DormantNeighbor {
  id: number
  embedding: Float32Array
  quality: number
  /** 余弦相似度 */
  sim: number
}

export interface ClusterInput {
  persons: PersonCentroid[]
  /** 从未尝试过的新脸 */
  pending: PendingFace[]
  /** faceId → 用户说过"不是此人"的 personId */
  rejections: Map<number, Set<number>>
  /** 用户驳回过的合并建议，key = pairKey(a, b) */
  dismissedPairs: Set<string>
  /** 在落单（已尝试过、仍未归属）的脸里找近邻，按相似度降序 */
  knnDormant: (vec: Float32Array, k: number) => DormantNeighbor[]
  /** 长循环里让出事件循环 */
  yieldFn?: () => Promise<void>
}

export interface ClusterPlan {
  /** 归入现有人物（含被合并后的） */
  assign: Array<{ faceId: number; personId: number }>
  /** 新建人物，每项是一组脸 */
  create: number[][]
  /** 现有人物合并：from 的脸全部并入 into */
  merges: Array<{ from: number; into: number }>
  /** 本批尝试过、仍未归属的新脸（之后只能被 KNN 拉回） */
  dormant: number[]
}

export const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

interface Cluster {
  key: number                // > 0 现有人物 id；< 0 本批临时簇
  named: boolean
  sum: Float64Array          // 成员 embedding 之和（现有人物用 质心×count 近似）
  centroid: Float32Array
  count: number
  added: number[]            // 本批新加入的脸
  forbid: Set<number>        // 成员脸拒绝过的 personId
  dirty: boolean
  parent: number             // 合并后指向的簇 key（自身 = 根）
}

export function dotF(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function normalizeInto(sum: Float64Array, out: Float32Array): void {
  let n = 0
  for (let i = 0; i < sum.length; i++) n += sum[i] * sum[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < sum.length; i++) out[i] = sum[i] / n
}

export async function clusterFaces(input: ClusterInput): Promise<ClusterPlan> {
  const { persons, rejections, dismissedPairs, knnDormant } = input
  const yieldFn = input.yieldFn ?? (async () => {})
  const dim = persons[0]?.centroid.length ?? input.pending[0]?.embedding.length ?? 512

  const clusters = new Map<number, Cluster>()
  for (const p of persons) {
    const sum = new Float64Array(dim)
    for (let i = 0; i < dim; i++) sum[i] = p.centroid[i] * p.count
    clusters.set(p.id, {
      key: p.id, named: p.named, sum, centroid: Float32Array.from(p.centroid), count: p.count,
      added: [], forbid: new Set(), dirty: false, parent: p.id,
    })
  }
  let nextTemp = -1
  const taken = new Set<number>()       // 本批已有归宿的脸（新脸 + 被拉回的落单脸）
  const qualityOf = new Map<number, number>()

  const find = (k: number): Cluster => {
    let c = clusters.get(k)!
    while (c.parent !== c.key) c = clusters.get(c.parent)!
    return c
  }
  // forbid 里记的 personId 可能已被并走，按合并链找根再比
  const forbids = (a: Cluster, b: Cluster): boolean => {
    for (const k of a.forbid) if (clusters.has(k) && find(k) === b) return true
    return false
  }
  const rejects = (faceId: number, c: Cluster): boolean => c.key > 0 && !!rejections.get(faceId)?.has(c.key)
  const add = (c: Cluster, faceId: number, emb: Float32Array): void => {
    for (let i = 0; i < dim; i++) c.sum[i] += emb[i]
    c.count++
    c.added.push(faceId)
    normalizeInto(c.sum, c.centroid)
    const r = rejections.get(faceId)
    if (r) for (const p of r) c.forbid.add(p)
    c.dirty = true
    taken.add(faceId)
  }
  /** 从落单脸里拉回与 vec 足够近的脸 */
  const pullDormant = (c: Cluster, vec: Float32Array, k: number, threshold: number): void => {
    for (const n of knnDormant(vec, k)) {
      if (n.sim < threshold) break
      if (taken.has(n.id) || n.quality < Q_MIN || rejects(n.id, c)) continue
      qualityOf.set(n.id, n.quality)
      add(c, n.id, n.embedding)
    }
  }

  // ── 1. 新脸逐个归入 / 开簇 ──
  const pending = [...input.pending].sort((a, b) => b.quality - a.quality)
  const dormant: number[] = []
  for (let fi = 0; fi < pending.length; fi++) {
    if (fi % 64 === 63) await yieldFn()
    const f = pending[fi]
    qualityOf.set(f.id, f.quality)
    if (taken.has(f.id)) continue
    if (f.quality < Q_MIN) { dormant.push(f.id); continue }

    let best: Cluster | null = null, bestSim = -1
    for (const c of clusters.values()) {
      if (c.parent !== c.key || rejects(f.id, c)) continue
      const s = dotF(f.embedding, c.centroid)
      if (s > bestSim) { bestSim = s; best = c }
    }
    const threshold = f.quality >= Q_SEED ? T_ASSIGN : T_ASSIGN_LOWQ
    if (best && bestSim >= threshold) {
      add(best, f.id, f.embedding)
    } else if (f.quality >= Q_SEED) {
      const key = nextTemp--
      const c: Cluster = {
        key, named: false, sum: new Float64Array(dim), centroid: new Float32Array(dim), count: 0,
        added: [], forbid: new Set(), dirty: true, parent: key,
      }
      clusters.set(key, c)
      add(c, f.id, f.embedding)
      pullDormant(c, f.embedding, 20, T_LINK)
    } else {
      dormant.push(f.id)
    }
  }

  // ── 2. 合并：只看涉及本批变动簇的组合 ──
  const merges: Array<{ from: number; into: number }> = []
  const roots = (): Cluster[] => [...clusters.values()].filter((c) => c.parent === c.key)
  const all = roots()
  const dirty = all.filter((c) => c.dirty)
  const pairs: Array<{ a: number; b: number; s: number }> = []
  for (let i = 0; i < dirty.length; i++) {
    if (i % 32 === 31) await yieldFn()
    const a = dirty[i]
    for (const b of all) {
      if (b === a || (b.dirty && b.key < a.key)) continue // 两个都 dirty 的组合只算一次
      const s = dotF(a.centroid, b.centroid)
      if (s >= T_MERGE) pairs.push({ a: a.key, b: b.key, s })
    }
  }
  pairs.sort((x, y) => y.s - x.s)
  for (const { a: ka, b: kb } of pairs) {
    const a = find(ka), b = find(kb)
    if (a === b || (a.named && b.named)) continue
    const s = dotF(a.centroid, b.centroid) // 之前的合并可能已改变质心
    if (s < (a.named || b.named ? T_MERGE_NAMED : T_MERGE)) continue
    if (forbids(a, b) || forbids(b, a)) continue
    if (a.key > 0 && b.key > 0 && dismissedPairs.has(pairKey(a.key, b.key))) continue
    // 保留谁：已命名 > 现有人物 > 脸多的
    const rank = (c: Cluster): number[] => [c.named ? 1 : 0, c.key > 0 ? 1 : 0, c.count]
    const [ra, rb] = [rank(a), rank(b)]
    const aWins = ra[0] !== rb[0] ? ra[0] > rb[0] : ra[1] !== rb[1] ? ra[1] > rb[1] : ra[2] >= rb[2]
    const [into, from] = aWins ? [a, b] : [b, a]
    for (let i = 0; i < dim; i++) into.sum[i] += from.sum[i]
    into.count += from.count
    into.added.push(...from.added)
    for (const p of from.forbid) into.forbid.add(p)
    normalizeInto(into.sum, into.centroid)
    into.dirty = true
    from.parent = into.key
    if (from.key > 0) merges.push({ from: from.key, into: into.key })
  }

  // ── 3. 质心变了的簇，再从落单脸里拉一次 ──
  for (const c of roots()) {
    if (!c.dirty || (c.key < 0 && c.count < MIN_FACES)) continue
    await yieldFn()
    pullDormant(c, c.centroid, 50, T_ASSIGN)
  }

  // ── 4. 输出 ──
  const pendingIds = new Set(input.pending.map((p) => p.id))
  const assign: ClusterPlan['assign'] = []
  const create: number[][] = []
  for (const c of roots()) {
    if (c.added.length === 0) continue
    if (c.key > 0) {
      for (const faceId of c.added) assign.push({ faceId, personId: c.key })
    } else if (c.count >= MIN_FACES) {
      // 封面 / 首张用质量最高的脸
      create.push([...c.added].sort((x, y) => (qualityOf.get(y) ?? 0) - (qualityOf.get(x) ?? 0)))
    } else {
      // 解散：新脸转落单；被拉回的旧落单脸本来就是落单
      for (const faceId of c.added) if (pendingIds.has(faceId)) dormant.push(faceId)
    }
  }
  return { assign, create, merges, dormant }
}

/**
 * 合并建议：质心相似度 ≥ T_SUGGEST 的人物对（两个已命名的除外）。
 * 不设上限：高于合并阈值却还是两个人物的，可能是手动拆开的、被"不是此人"挡住的，
 * 或是一直没有新脸触发合并检查的 —— 都交给用户确认，驳回一次就不再出现。
 */
export function suggestMerges(
  persons: PersonCentroid[],
  dismissedPairs: Set<string>,
  limit = 20
): Array<{ a: number; b: number; similarity: number }> {
  const out: Array<{ a: number; b: number; similarity: number }> = []
  for (let i = 0; i < persons.length; i++) {
    for (let j = i + 1; j < persons.length; j++) {
      const a = persons[i], b = persons[j]
      if (a.named && b.named) continue
      const s = dotF(a.centroid, b.centroid)
      if (s < T_SUGGEST) continue
      if (dismissedPairs.has(pairKey(a.id, b.id))) continue
      // 已命名的放 a，界面上问"X 是不是 <已命名>"
      out.push(b.named && !a.named ? { a: b.id, b: a.id, similarity: s } : { a: a.id, b: b.id, similarity: s })
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, limit)
}
