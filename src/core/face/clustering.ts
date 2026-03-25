/**
 * Chinese Whispers 人脸聚类
 * 基于余弦相似度构建图，无监督聚类
 */

const SIMILARITY_THRESHOLD = 0.5  // 余弦相似度阈值，超过此值建立边
const MAX_ITERATIONS = 100

interface FaceNode {
  id: number
  embedding: Float32Array
  label: number
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot  // 已 L2 归一化，dot product = cosine similarity
}

/**
 * Chinese Whispers 聚类
 * @param faces 人脸列表 (id + embedding)
 * @returns Map<faceId, clusterId>
 */
export function clusterFaces(
  faces: Array<{ id: number; embedding: Float32Array }>
): Map<number, number> {
  if (faces.length === 0) return new Map()

  // 初始化：每个节点是自己的类
  const nodes: FaceNode[] = faces.map((f) => ({
    id: f.id,
    embedding: f.embedding,
    label: f.id,
  }))

  // 构建邻接表（稀疏图）
  const neighbors = new Map<number, Array<{ nodeIdx: number; weight: number }>>()
  for (let i = 0; i < nodes.length; i++) {
    neighbors.set(i, [])
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const sim = cosineSimilarity(nodes[i].embedding, nodes[j].embedding)
      if (sim > SIMILARITY_THRESHOLD) {
        neighbors.get(i)!.push({ nodeIdx: j, weight: sim })
        neighbors.get(j)!.push({ nodeIdx: i, weight: sim })
      }
    }
  }

  // 迭代
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false

    // 随机打乱节点顺序
    const order = Array.from({ length: nodes.length }, (_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }

    for (const idx of order) {
      const nbrs = neighbors.get(idx)!
      if (nbrs.length === 0) continue

      // 统计邻居标签的加权票数
      const votes = new Map<number, number>()
      for (const { nodeIdx, weight } of nbrs) {
        const label = nodes[nodeIdx].label
        votes.set(label, (votes.get(label) || 0) + weight)
      }

      // 选择票数最高的标签
      let bestLabel = nodes[idx].label
      let bestWeight = 0
      for (const [label, weight] of votes) {
        if (weight > bestWeight) {
          bestWeight = weight
          bestLabel = label
        }
      }

      if (bestLabel !== nodes[idx].label) {
        nodes[idx].label = bestLabel
        changed = true
      }
    }

    if (!changed) break
  }

  // 转换结果
  const result = new Map<number, number>()
  for (const node of nodes) {
    result.set(node.id, node.label)
  }

  return result
}
