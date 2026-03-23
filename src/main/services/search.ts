/**
 * 搜索引擎
 * 结合向量搜索和 BM25 文本搜索
 */

import type { DatabaseInstance } from '../db'
import type { SearchResult } from '../../shared/types'
import { getEmbeddingService } from './embedding'

interface VecSearchResult {
  fileHash: string
  distance: number
}

interface TextSearchResult {
  fileHash: string
  score: number
}

export class SearchEngine {
  private db: DatabaseInstance

  constructor(db: DatabaseInstance) {
    this.db = db
  }

  async search(query: string, limit: number = 50): Promise<SearchResult[]> {
    const trimmedQuery = query.trim()

    if (!trimmedQuery) {
      return this.getRecentPhotos(limit)
    }

    console.log(`Searching for: "${trimmedQuery}", limit: ${limit}`)

    try {
      const [vecResults, textResults] = await Promise.all([
        this.searchByVector(trimmedQuery, limit * 2),
        this.searchByBM25(trimmedQuery, limit * 2),
      ])

      console.log(`Vector results: ${vecResults.length}, BM25 results: ${textResults.length}`)

      // RRF 融合排序并归一化分数
      const mergedResults = this.rrfMerge(vecResults, textResults, 60)

      const maxScore = mergedResults.length > 0 ? mergedResults[0].score : 1
      for (const r of mergedResults) {
        r.score = r.score / maxScore
      }

      // 映射到代表照片
      const results: SearchResult[] = []
      const seenHashes = new Set<string>()

      for (const { fileHash, score } of mergedResults) {
        if (seenHashes.has(fileHash)) continue
        seenHashes.add(fileHash)

        const photo = this.db.getRepresentativeByHash(fileHash)
        if (photo && !photo.deletedAt) {
          results.push({ photo, score })
          if (results.length >= limit) break
        }
      }

      // 结果不足时补充最近照片
      if (results.length < limit) {
        const recent = this.db.getRepresentativePhotos(limit - results.length)
        for (const photo of recent) {
          if (!seenHashes.has(photo.fileHash)) {
            results.push({ photo, score: 0.1 })
          }
        }
      }

      return results
    } catch (error) {
      console.error('Search error:', error)
      return this.getRecentPhotos(limit)
    }
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

    return Array.from(scores.entries())
      .map(([fileHash, score]) => ({ fileHash, score }))
      .sort((a, b) => b.score - a.score)
  }

  private getRecentPhotos(limit: number): SearchResult[] {
    const photos = this.db.getRepresentativePhotos(limit)
    return photos.map((photo) => ({ photo, score: 1.0 }))
  }
}
