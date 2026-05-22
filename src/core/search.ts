/**
 * 搜索引擎 — 4-way RRF（vector + caption BM25 + ocr BM25 + filename）
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

    try {
      // 并行四路：vec 语义 / caption FTS5 / ocr FTS5 / 文件名 LIKE
      const [vecResults, captionResults, ocrResults, fileNameResults] = await Promise.all([
        this.searchByVector(trimmedQuery, limit * 2),
        Promise.resolve(this.searchByBM25(trimmedQuery, limit * 2)),
        Promise.resolve(this.searchByOcr(trimmedQuery, limit * 2)),
        Promise.resolve(this.db.searchByFileName(trimmedQuery, limit * 2)),
      ])

      // RRF 融合
      const mergedResults = this.rrfMerge(vecResults, captionResults, ocrResults, fileNameResults, 60)

      const maxScore = mergedResults.length > 0 ? mergedResults[0].score : 1
      for (const r of mergedResults) {
        r.score = r.score / maxScore
      }

      const results: SearchResult[] = []
      const seenHashes = new Set<string>()
      for (const { fileHash, score } of mergedResults) {
        if (seenHashes.has(fileHash)) continue
        seenHashes.add(fileHash)

        const photo = this.db.getRepresentativeByHash(fileHash)
        if (photo && !photo.deletedAt) {
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

  private searchByOcr(query: string, limit: number): TextSearchResult[] {
    try {
      return this.db.searchByOcr(query, limit)
    } catch (error) {
      console.error('OCR search failed:', error)
      return []
    }
  }

  /**
   * RRF (Reciprocal Rank Fusion) 4 路融合。
   *
   * 各路 weight 设计：
   * - vec / caption / ocr / filename 等权（都是 1/(k+rank+1)）
   *
   * 不区分权重的原因：OCR 是精确匹配，BM25 已经偏严；语义向量是宽召回；
   * 文件名是用户主动命名的信号。让 rank 衰减自然决定哪个胜出。
   */
  private rrfMerge(
    vecResults: VecSearchResult[],
    captionResults: TextSearchResult[],
    ocrResults: TextSearchResult[],
    fileNameResults: Array<{ fileHash: string }>,
    k: number = 60
  ): Array<{ fileHash: string; score: number }> {
    const scores = new Map<string, number>()

    vecResults
      .sort((a, b) => a.distance - b.distance)
      .forEach((r, rank) => {
        scores.set(r.fileHash, (scores.get(r.fileHash) || 0) + 1 / (k + rank + 1))
      })

    captionResults
      .sort((a, b) => b.score - a.score)
      .forEach((r, rank) => {
        scores.set(r.fileHash, (scores.get(r.fileHash) || 0) + 1 / (k + rank + 1))
      })

    ocrResults
      .sort((a, b) => b.score - a.score)
      .forEach((r, rank) => {
        scores.set(r.fileHash, (scores.get(r.fileHash) || 0) + 1 / (k + rank + 1))
      })

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
