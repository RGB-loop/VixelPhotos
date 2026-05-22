/**
 * Reciprocal Rank Fusion —— 把多路检索（vec / BM25 / OCR / 文件名 ...）
 * 的结果按 1/(k + rank) 加权累加，得到统一排序。
 *
 * 抽到独立模块的原因：
 *   - 纯函数，便于单测
 *   - 让 search.ts 不需要再嵌一个私有方法
 */

/** 单路检索结果：通过排名贡献分数（越前越高），不需要原始 score */
export interface RankedItem {
  fileHash: string
}

export interface FusedItem {
  fileHash: string
  score: number
}

/**
 * 多路 RRF 融合。所有通道等权。
 *
 * @param channels 每路结果数组（按相关性降序）
 * @param k        RRF 衰减常数，默认 60（IR 文献的经验值）
 */
export function rrfFuse<T extends RankedItem>(
  channels: T[][],
  k: number = 60
): FusedItem[] {
  const scores = new Map<string, number>()
  for (const channel of channels) {
    channel.forEach((r, rank) => {
      scores.set(r.fileHash, (scores.get(r.fileHash) || 0) + 1 / (k + rank + 1))
    })
  }
  return Array.from(scores.entries())
    .map(([fileHash, score]) => ({ fileHash, score }))
    .sort((a, b) => b.score - a.score)
}
