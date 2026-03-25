/**
 * 搜索引擎
 * 结合向量搜索、BM25 文本搜索和文件名搜索
 */

import type { DatabaseInstance } from './db'
import type { SearchResult } from '../shared/types'
import { getEmbeddingService } from './embedding'

interface VecSearchResult {
  fileHash: string
  distance: number
}

interface TextSearchResult {
  fileHash: string
  score: number
}

export interface SearchOptions {
  query?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
}

export class SearchEngine {
  private db: DatabaseInstance

  constructor(db: DatabaseInstance) {
    this.db = db
  }

  async search(query: string, limit: number = 50, options?: { dateFrom?: string; dateTo?: string }): Promise<SearchResult[]> {
    const trimmedQuery = query.trim()
    const dateFrom = options?.dateFrom
    const dateTo = options?.dateTo

    // 无搜索词：按时间过滤或返回最近照片
    if (!trimmedQuery) {
      if (dateFrom || dateTo) {
        const photos = this.db.getRepresentativePhotosFiltered(limit, 0, dateFrom, dateTo)
        return photos.map((photo) => ({ photo, score: 1.0 }))
      }
      return this.getRecentPhotos(limit)
    }

    console.log(`Searching for: "${trimmedQuery}", limit: ${limit}`)

    try {
      // 并行执行三种搜索
      const [vecResults, textResults, fileNameResults] = await Promise.all([
        this.searchByVector(trimmedQuery, limit * 2),
        this.searchByBM25(trimmedQuery, limit * 2),
        Promise.resolve(this.db.searchByFileName(trimmedQuery, limit * 2)),
      ])

      console.log(`Vector: ${vecResults.length}, BM25: ${textResults.length}, FileName: ${fileNameResults.length}`)

      // RRF 融合排序
      const mergedResults = this.rrfMerge(vecResults, textResults, fileNameResults, 60)

      const maxScore = mergedResults.length > 0 ? mergedResults[0].score : 1
      for (const r of mergedResults) {
        r.score = r.score / maxScore
      }

      // 映射到代表照片（加时间过滤）
      const results: SearchResult[] = []
      const seenHashes = new Set<string>()

      for (const { fileHash, score } of mergedResults) {
        if (seenHashes.has(fileHash)) continue
        seenHashes.add(fileHash)

        const photo = this.db.getRepresentativeByHash(fileHash)
        if (photo && !photo.deletedAt) {
          // 时间过滤
          if (dateFrom && photo.takenAt && photo.takenAt < dateFrom) continue
          if (dateTo && photo.takenAt && photo.takenAt > dateTo) continue
          results.push({ photo, score })
          if (results.length >= limit) break
        }
      }

      return results
    } catch (error) {
      console.error('Search error:', error)
      return this.getRecentPhotos(limit)
    }
  }

  /** 查找相似照片 */
  findSimilar(fileHash: string, limit: number = 12): SearchResult[] {
    const results = this.db.findSimilar(fileHash, limit)
    const photos: SearchResult[] = []
    for (const { fileHash: hash, distance } of results) {
      const photo = this.db.getRepresentativeByHash(hash)
      if (photo && !photo.deletedAt) {
        photos.push({ photo, score: 1 - distance })
      }
    }
    return photos
  }

  private async searchByVector(query: string, limit: number): Promise<VecSearchResult[]> {
    try {
      const embeddingService = getEmbeddingService()
      if (!embeddingService.isReady()) return []
      const queryVec = await embeddingService.encodeText(query)
      return this.db.searchByVec(queryVec, limit)
    } catch (error) {
      console.error('Vector search failed:', error)
      return []
    }
  }

  private searchByBM25(query: string, limit: number): TextSearchResult[] {
    try {
      return this.db.searchByText(query, limit)
    } catch (error) {
      console.error('BM25 search failed:', error)
      return []
    }
  }

  private rrfMerge(
    vecResults: VecSearchResult[],
    textResults: TextSearchResult[],
    fileNameResults: Array<{ fileHash: string }>,
    k: number = 60
  ): Array<{ fileHash: string; score: number }> {
    const scores = new Map<string, number>()

    vecResults
      .sort((a, b) => a.distance - b.distance)
      .forEach((r, rank) => {
        scores.set(r.fileHash, (scores.get(r.fileHash) || 0) + 1 / (k + rank + 1))
      })

    textResults
      .sort((a, b) => b.score - a.score)
      .forEach((r, rank) => {
        scores.set(r.fileHash, (scores.get(r.fileHash) || 0) + 1 / (k + rank + 1))
      })

    // 文件名匹配权重较高（直接给固定分数，不按排名递减）
    fileNameResults.forEach((r, rank) => {
      scores.set(r.fileHash, (scores.get(r.fileHash) || 0) + 1 / (k + rank + 1))
    })

    return Array.from(scores.entries())
      .map(([fileHash, score]) => ({ fileHash, score }))
      .sort((a, b) => b.score - a.score)
  }

  private getRecentPhotos(limit: number): SearchResult[] {
    const photos = this.db.getRepresentativePhotos(limit)
    return photos.map((photo) => ({ photo, score: 1.0 }))
  }
}
