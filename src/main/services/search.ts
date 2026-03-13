import type { DatabaseInstance } from '../db'
import type { SearchResult, Photo } from '../../shared/types'
import { getTextEmbedding } from './textEmbedding'

interface VecSearchResult {
  photoId: number
  distance: number
}

export class SearchEngine {
  private db: DatabaseInstance

  constructor(db: DatabaseInstance) {
    this.db = db
  }

  /**
   * 语义搜索照片
   */
  async search(query: string, limit: number = 50): Promise<SearchResult[]> {
    const trimmedQuery = query.trim()

    if (!trimmedQuery) {
      return this.getRecentPhotos(limit)
    }

    console.log(`Searching for: "${trimmedQuery}", limit: ${limit}`)

    try {
      // 1. 生成查询向量
      const textEmbedding = getTextEmbedding()
      const queryVec = await textEmbedding.encode(trimmedQuery)

      // 2. 双路检索（并行）
      const [imageResults, captionResults] = await Promise.all([
        this.searchByImageVec(queryVec, limit * 2),
        this.searchByCaptionVec(queryVec, limit * 2),
      ])

      console.log(
        `Image results: ${imageResults.length}, Caption results: ${captionResults.length}`
      )

      // 3. RRF 融合排序
      const mergedIds = this.rrfMerge(imageResults, captionResults, 60)

      // 4. 获取照片详情并构建结果
      const results: SearchResult[] = []
      const seenIds = new Set<number>()

      for (const { photoId, score } of mergedIds) {
        if (seenIds.has(photoId)) continue
        seenIds.add(photoId)

        const photo = this.db.getPhoto(photoId)
        if (photo && !photo.deletedAt) {
          results.push({
            photo,
            score,
          })

          if (results.length >= limit) break
        }
      }

      // 如果结果太少，用最新照片补充
      if (results.length < limit) {
        const recent = this.db.getPhotos(limit - results.length)
        for (const photo of recent) {
          if (!seenIds.has(photo.id)) {
            results.push({ photo, score: 0.1 })
          }
        }
      }

      return results
    } catch (error) {
      console.error('Search error:', error)
      // 降级到返回最新照片
      return this.getRecentPhotos(limit)
    }
  }

  /**
   * 通过图像向量搜索
   * 注意：这里使用文本查询向量与图像向量做跨模态搜索
   * 需要模型支持（如 CLIP/SigLIP 的文本-图像对齐）
   */
  private async searchByImageVec(
    queryVec: Float32Array,
    limit: number
  ): Promise<VecSearchResult[]> {
    try {
      // SigLIP 支持跨模态搜索，但我们当前使用的是不同的文本模型
      // 所以这里暂时返回空结果，主要依赖 caption 搜索
      // TODO: 使用 SigLIP 的文本编码器生成查询向量
      return []
    } catch (error) {
      console.error('Image vector search failed:', error)
      return []
    }
  }

  /**
   * 通过 Caption 向量搜索
   */
  private async searchByCaptionVec(
    queryVec: Float32Array,
    limit: number
  ): Promise<VecSearchResult[]> {
    try {
      return this.db.searchByCaptionVec(queryVec, limit)
    } catch (error) {
      console.error('Caption vector search failed:', error)
      return []
    }
  }

  /**
   * RRF (Reciprocal Rank Fusion) 融合排序
   * @param lists 多个搜索结果列表
   * @param k RRF 常数（默认 60）
   */
  private rrfMerge(
    list1: VecSearchResult[],
    list2: VecSearchResult[],
    k: number = 60
  ): Array<{ photoId: number; score: number }> {
    const scores = new Map<number, number>()

    // 处理第一个列表（按距离排序，距离越小排名越高）
    list1
      .sort((a, b) => a.distance - b.distance)
      .forEach((r, rank) => {
        const rrfScore = 1 / (k + rank + 1)
        scores.set(r.photoId, (scores.get(r.photoId) || 0) + rrfScore)
      })

    // 处理第二个列表
    list2
      .sort((a, b) => a.distance - b.distance)
      .forEach((r, rank) => {
        const rrfScore = 1 / (k + rank + 1)
        scores.set(r.photoId, (scores.get(r.photoId) || 0) + rrfScore)
      })

    // 转换为数组并排序
    const merged = Array.from(scores.entries())
      .map(([photoId, score]) => ({ photoId, score }))
      .sort((a, b) => b.score - a.score)

    return merged
  }

  /**
   * 获取最近的照片（无搜索词时的默认结果）
   */
  private getRecentPhotos(limit: number): SearchResult[] {
    const photos = this.db.getPhotos(limit)
    return photos.map((photo) => ({
      photo,
      score: 1.0,
    }))
  }
}
