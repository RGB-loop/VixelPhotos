/**
 * 搜索引擎 — 4-way RRF（image vec + 音视频片段 vec + ocr BM25 + filename）
 */

import type { DatabaseInstance } from './db'
import type { MediaKind, SearchResult } from '../shared/types'
import { getEmbeddingService } from './embedding'
import { rrfFuse } from './fusion'

interface VecSearchResult {
  fileHash: string
  distance: number
}

interface VideoSegmentSearchResult {
  videoId: number
  startMs: number
  endMs: number
  distance: number
}

interface TextSearchResult {
  fileHash: string
  score: number
}

export interface SearchOptions {
  dateFrom?: string
  dateTo?: string
  /** 只返回某种媒体；省略 = 全部 */
  kind?: MediaKind
  /** 只返回出现在该监视文件夹里的内容 */
  folderId?: number
}

export class SearchEngine {
  private db: DatabaseInstance

  constructor(db: DatabaseInstance) {
    this.db = db
  }

  async search(query: string, limit: number = 50, options?: SearchOptions): Promise<SearchResult[]> {
    const trimmedQuery = query.trim()
    const dateFrom = options?.dateFrom
    const dateTo = options?.dateTo
    const kind = options?.kind
    const folderId = options?.folderId

    // 无搜索词：按时间 / 类型过滤或返回最近照片
    if (!trimmedQuery) {
      if (dateFrom || dateTo || kind || folderId != null) {
        const photos = this.db.getRepresentativePhotosFiltered(limit, 0, dateFrom, dateTo, kind, folderId)
        return photos.map((photo) => ({ photo, score: 1.0 }))
      }
      return this.getRecentPhotos(limit)
    }

    try {
      // 查询向量只编码一次，图片通道和视频片段通道共用。
      // 这是唯一的异步步骤，之后四路检索都是同步的 SQLite 查询。
      const queryVec = await this.encodeQuery(trimmedQuery)

      // 四路召回（caption 通道已删除）：图片 vec / 片段 vec / ocr BM25 / 文件名 LIKE。
      // 按类型过滤时跳过用不上的通道：片段只属于音视频；图片向量和 OCR 只对图片 + 视频首帧有意义
      const wantSegments = kind !== 'image'
      const wantImageChannels = kind !== 'audio'
      const imageVecResults = wantImageChannels ? this.searchByVector(queryVec, limit * 2) : []
      const videoSegmentResults = wantSegments ? this.searchVideoSegments(queryVec, limit * 2) : []
      const ocrResults = wantImageChannels ? this.searchByOcr(trimmedQuery, limit * 2) : []
      const fileNameResults = this.db.searchByFileName(trimmedQuery, limit * 2)

      // 片段命中 → 映射到该媒体代表 photo 的 fileHash，
      // 这样才能和图片通道在同一个 id 空间里融合；同时记下命中区间给 UI 定位
      const videoSegmentAsFileHash: VecSearchResult[] = []
      const segmentByHash = new Map<string, { startMs: number; endMs: number }>()
      for (const seg of videoSegmentResults) {
        const frames = this.db.getFramePhotosByVideo(seg.videoId)
        const frame = frames.find((f) => !f.deletedAt) ?? frames[0]
        if (frame?.fileHash) {
          videoSegmentAsFileHash.push({ fileHash: frame.fileHash, distance: seg.distance })
          segmentByHash.set(frame.fileHash, { startMs: seg.startMs, endMs: seg.endMs })
        }
      }
      const segmentHashes = new Set(segmentByHash.keys())

      // 代表帧也有图片向量：已被片段通道命中的视频从图片通道剔除，
      // 否则 RRF 会把同一视频累加两次，视频几乎霸占所有查询的前排
      const imageOnlyResults = imageVecResults.filter((r) => !segmentHashes.has(r.fileHash))

      // RRF 融合（各通道先按相关性排序好，再交给 fusion）
      const mergedResults = rrfFuse(
        [
          [...imageOnlyResults].sort((a, b) => a.distance - b.distance),
          [...videoSegmentAsFileHash].sort((a, b) => a.distance - b.distance),
          [...ocrResults].sort((a, b) => b.score - a.score),
          fileNameResults,
        ],
        60
      )

      const maxScore = mergedResults.length > 0 ? mergedResults[0].score : 1
      for (const r of mergedResults) {
        r.score = r.score / maxScore
      }

      const folderHashes = folderId != null ? this.db.getHashesInFolder(folderId) : null
      const results: SearchResult[] = []
      const seenHashes = new Set<string>()
      const seenVideos = new Set<number>()
      for (const { fileHash, score } of mergedResults) {
        if (seenHashes.has(fileHash)) continue
        seenHashes.add(fileHash)
        if (folderHashes && !folderHashes.has(fileHash)) continue

        const photo = this.db.getRepresentativeByHash(fileHash)
        if (photo && !photo.deletedAt) {
          if (dateFrom && photo.takenAt && photo.takenAt < dateFrom) continue
          if (dateTo && photo.takenAt && photo.takenAt > dateTo) continue
          if (kind && (photo.mediaKind ?? 'image') !== kind) continue
          // 视频去重：同一视频的多个帧只保留首个（已按 score 降序，所以是最佳帧）
          if (photo.videoId != null) {
            if (seenVideos.has(photo.videoId)) continue
            seenVideos.add(photo.videoId)
          }
          const segment = segmentByHash.get(fileHash)
          results.push(segment ? { photo, score, segment } : { photo, score })
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
    // 取超采，因为下面会按 hash + video 去重，可能丢一部分
    const results = this.db.findSimilar(fileHash, limit * 3)
    const photos: SearchResult[] = []
    const seenHashes = new Set<string>([fileHash]) // 排除查询本身
    const seenVideos = new Set<number>()
    for (const { fileHash: hash, distance } of results) {
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)
      const photo = this.db.getRepresentativeByHash(hash)
      if (photo && !photo.deletedAt) {
        if (photo.videoId != null) {
          if (seenVideos.has(photo.videoId)) continue
          seenVideos.add(photo.videoId)
        }
        photos.push({ photo, score: 1 - distance })
        if (photos.length >= limit) break
      }
    }
    return photos
  }

  private async encodeQuery(query: string): Promise<Float32Array | null> {
    try {
      const embeddingService = getEmbeddingService()
      if (!embeddingService.isReady()) return null
      return await embeddingService.encodeText(query)
    } catch (error) {
      console.error('Query encoding failed:', error)
      return null
    }
  }

  private searchByVector(queryVec: Float32Array | null, limit: number): VecSearchResult[] {
    if (!queryVec) return []
    try {
      return this.db.searchByVec(queryVec, limit)
    } catch (error) {
      console.error('Vector search failed:', error)
      return []
    }
  }

  private searchVideoSegments(queryVec: Float32Array | null, limit: number): VideoSegmentSearchResult[] {
    if (!queryVec) return []
    try {
      const rawResults = this.db.searchVideoSegmentsByVec(queryVec, limit)
      // 按 videoId 去重，保留每个视频的最佳片段
      const bestPerVideo = new Map<number, VideoSegmentSearchResult>()
      for (const seg of rawResults) {
        const existing = bestPerVideo.get(seg.videoId)
        if (!existing || seg.distance < existing.distance) {
          bestPerVideo.set(seg.videoId, seg)
        }
      }
      return Array.from(bestPerVideo.values())
    } catch (error) {
      console.error('Video segment search failed:', error)
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

  private getRecentPhotos(limit: number): SearchResult[] {
    const photos = this.db.getRepresentativePhotos(limit)
    return photos.map((photo) => ({ photo, score: 1.0 }))
  }
}
