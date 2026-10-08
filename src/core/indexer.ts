import { EventEmitter } from 'events'
import { basename, join } from 'path'
import { mkdir, rm, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import sharp from 'sharp'
import exifr from 'exifr'
import xxhash from 'xxhash-wasm'
import type { DatabaseInstance } from './db'
import type { IndexProgress } from '../shared/types'
import { getEmbeddingService } from './embedding'
import { initFaceService, isFaceServiceReady, processPhotoFaces, assignFaceToPerson } from './face'
import { initOcrService, isOcrReady, processPhotoOcr } from './ocr'
import { decodeImage } from './image/decode'
import { extractKeyframes, isFfmpegAvailable, probeDurationMs } from './video/extract'
import { extractAudioTrack } from './audio/extract'

// xxHash 懒加载（与 watcher 共用语义；模块级单例避免重复 init）
let _hasher: ((input: Uint8Array) => string) | null = null
async function getXxhasher(): Promise<(input: Uint8Array) => string> {
  if (_hasher) return _hasher
  const h = await xxhash()
  _hasher = (data: Uint8Array) => h.h64Raw(data).toString(16).padStart(16, '0')
  return _hasher
}

/**
 * Indexer 流水线（纯本地，无 LLM）：
 *   图片：thumbnail → embed (EmbeddingGemma 2) → face / ocr (按需)
 *   视频：extract_frames → 32s 片段（帧序列 + 音轨）→ EmbeddingGemma 2 → video_segments
 */
const PAUSED_KEY = 'indexing_paused'

export class Indexer extends EventEmitter {
  private db: DatabaseInstance
  private userDataPath: string
  private thumbnailDir: string
  private isProcessing = false
  private modelsLoaded = false
  private modelsLoading = false
  // 暂停：不再取新任务；正在跑的视频在片段之间停住，继续后从断点接着跑
  private paused: boolean
  private resumeWaiters: Array<() => void> = []

  constructor(db: DatabaseInstance, userDataPath: string) {
    super()
    this.db = db
    this.userDataPath = userDataPath
    this.thumbnailDir = join(userDataPath, 'thumbnails')
    this.ensureThumbnailDir()
    // 持久化：暂停后退出应用，下次启动仍保持暂停
    this.paused = db.getMetaState(PAUSED_KEY) === '1'
  }

  isPaused(): boolean {
    return this.paused
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    this.db.setMetaState(PAUSED_KEY, paused ? '1' : '0')
    if (!paused) {
      const waiters = this.resumeWaiters
      this.resumeWaiters = []
      for (const resume of waiters) resume()
      this.processNext()
    }
    this.emitProgress(this.isProcessing ? 'indexing' : 'idle')
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve()
    this.emitProgress('idle')
    return new Promise((resolve) => this.resumeWaiters.push(resolve))
  }

  /** 手动触发 OCR 扫描（已 embed 但未 OCR 的照片） */
  async startOcrScan(): Promise<{ queued: number }> {
    const ready = await initOcrService()
    if (!ready) {
      throw new Error('OCR models not available — run `npm run models:download` first')
    }
    const pending = this.db.getPendingOcrPhotos()
    for (const photo of pending) {
      this.db.addToQueue(photo.id, 'ocr', 4)
    }
    if (pending.length > 0) {
      this.processNext()
    }
    return { queued: pending.length }
  }

  /** 手动触发人脸扫描 */
  async startFaceScan(): Promise<{ queued: number }> {
    const ready = await initFaceService()
    if (!ready) {
      throw new Error('Face models not available')
    }

    const pending = this.db.getPendingFacePhotos()
    for (const photo of pending) {
      this.db.addToQueue(photo.id, 'face', 8)
    }

    if (pending.length > 0) {
      this.processNext()
    }

    return { queued: pending.length }
  }

  private async processOcr(fileHash: string, filePath: string): Promise<void> {
    try {
      const { hasOcr } = this.db.hasContentForHash(fileHash)
      if (hasOcr) return // 同内容已 OCR 过

      if (!isOcrReady()) {
        const ok = await initOcrService()
        if (!ok) {
          // 没装 OCR 模型：不抛错，静默跳过（向量 + 文件名通道仍可用）
          return
        }
      }

      const decoded = await decodeImage(filePath)
      const result = await processPhotoOcr(decoded.buffer)
      if (result.text.trim().length > 0) {
        this.db.saveOcrText(fileHash, result.text)
      } else {
        // 写空串以标记"扫过了，无文字"，避免重复扫
        this.db.saveOcrText(fileHash, '')
      }
    } catch (error) {
      console.error(`Error processing OCR for ${filePath}:`, error)
      throw error
    }
  }

  /**
   * 处理 'extract_frames' 任务：
   *   1. 视频切分 32s 片段 → 抽帧序列 + 音轨 → Gemma2 多模态编码 → video_segments 表
   *   2. 全视频首帧抽取 → 缩略图（UI 展示用）
   *
   * 帧本身仍写到 <userData>/video_frames/<videoHash>/ 供缩略图和调试，
   * 但不为每帧单独生成 photo 行 + image embedding；搜索直接走 video_segments。
   */
  private async processExtractFrames(videoId: number): Promise<void> {
    const video = this.db.getVideoById(videoId)
    if (!video) return // 视频已被删除

    if (!isFfmpegAvailable()) {
      throw new Error('ffmpeg binary not available — install ffmpeg-static or rebuild app')
    }

    this.emitProgress('indexing', basename(video.filePath))

    // 清理该视频上一轮的片段向量 + 抽帧（DB + 磁盘）
    this.db.deleteVideoSegments(videoId)
    const orphanedOldHashes = this.db.removeFramesForVideo(videoId)
    for (const hash of orphanedOldHashes) {
      const thumb = this.getThumbnailPath(hash)
      try {
        if (existsSync(thumb)) await unlink(thumb)
      } catch { /* best-effort */ }
    }
    const framesDir = this.getVideoFramesDir(video.fileHash)
    if (existsSync(framesDir)) {
      try {
        await rm(framesDir, { recursive: true, force: true })
      } catch { /* best-effort */ }
    }

    let durationMs = video.durationMs ?? 0
    if (durationMs <= 0) {
      durationMs = (await probeDurationMs(video.filePath)) ?? 0
      if (durationMs <= 0) {
        // 读不到时长 → 视频损坏 / 无效；frame_count=0 表示"扫过了但没内容"
        this.db.updateVideoMeta(videoId, { frameCount: 0 })
        return
      }
      this.db.updateVideoMeta(videoId, { durationMs })
    }

    // 模型没就绪时只落代表帧（让视频出现在网格里），然后抛错：
    // 否则每个片段都静默失败、任务却标 done，视频永远没有片段向量。
    // 任务记 error，下次启动 requeueMissingEmbeddings 按"有时长、无片段"重新排队。
    const embeddingService = getEmbeddingService()
    await embeddingService.init()
    const modelReady = embeddingService.isReady()

    // 32s 片段，每 4s 一帧 → 8 帧。vision encoder 开销随帧数超线性增长：
    // 实测 M 系列 CPU 上 8 帧 ≈ 14s / 16 帧 ≈ 43s / 32 帧 ≈ 141s（峰值 3.9GB），
    // 1fps 对长视频不可用。8 帧 × 140 token + 32s 音频 ≈ 2K token，远低于 8K context
    const SEGMENT_DURATION_SEC = 32
    const FRAME_INTERVAL_SEC = 4
    const numSegments = Math.max(1, Math.ceil(durationMs / 1000 / SEGMENT_DURATION_SEC))

    if (!existsSync(framesDir)) {
      await mkdir(framesDir, { recursive: true })
    }

    const hasher = await getXxhasher()

    // 为每个片段：抽帧序列 + 音轨 → Gemma2 多模态编码
    for (let i = 0; i < numSegments; i++) {
      await this.waitIfPaused()
      // 长视频要跑很久，期间文件夹可能被移除
      if (!this.db.getVideoById(videoId)) return
      const startMs = i * SEGMENT_DURATION_SEC * 1000
      const endMs = Math.min((i + 1) * SEGMENT_DURATION_SEC * 1000, durationMs)
      const segmentDurationSec = (endMs - startMs) / 1000

      try {
        const frames = await extractKeyframes(video.filePath, {
          startSec: startMs / 1000,
          durationSec: segmentDurationSec,
          intervalSec: FRAME_INTERVAL_SEC,
          maxFrames: SEGMENT_DURATION_SEC / FRAME_INTERVAL_SEC,
          maxSide: 512,
        })

        if (frames.length === 0) {
          // 空片段 / 损坏部分 → 跳过，不保存 segment 行
          continue
        }

        // 首段的首帧先落成代表 photo —— 放在编码之前，
        // 这样即便模型没就绪 / 编码失败，视频依然出现在网格里。
        if (i === 0) {
          const firstFrameFileName = `segment_${i}_0ms.jpg`
          const firstFramePath = join(framesDir, firstFrameFileName)
          if (!existsSync(firstFramePath)) {
            await writeFile(firstFramePath, frames[0].buffer)
          }
          const frameHash = hasher(new Uint8Array(frames[0].buffer.buffer, frames[0].buffer.byteOffset, frames[0].buffer.byteLength))

          // 首帧作为视频的代表 photo：网格缩略图、搜索结果落点、"相似照片"入口。
          // 它也走一遍图片 embed，否则 requeueMissingEmbeddings 启动时还会补排。
          const photoId = this.db.addPhoto(
            video.folderId, firstFramePath, firstFrameFileName,
            frames[0].buffer.byteLength, Date.now(), frameHash,
            { videoId, frameTimeMs: 0 }
          )
          this.db.addToQueue(photoId, 'thumbnail', 20)
          if (this.db.hasContentForHash(frameHash).hasEmbedding) {
            this.db.updateEmbedStatusByHash(frameHash)
          } else {
            this.db.addToQueue(photoId, 'embed', 10)
          }
        }

        if (!modelReady) break

        const frameBuffers = frames.map((f) => f.buffer)

        // 提取该片段的音轨（mono 16kHz f32le）
        let audioSamples: Float32Array | null = null
        try {
          audioSamples = await extractAudioTrack(video.filePath, {
            startSec: startMs / 1000,
            durationSec: segmentDurationSec,
          })
        } catch (audioError) {
          console.warn(`Audio extraction failed for segment ${i} of ${video.filePath}:`, audioError)
          // 无音轨 / 损坏音频 → 仅视觉模态继续
        }

        // Gemma2 多模态编码：帧序列 + 音轨 → 单向量；无音轨时退化为纯视觉
        const clip = { frames: frameBuffers, durationSec: segmentDurationSec }
        const embedding = audioSamples && audioSamples.length > 0
          ? await embeddingService.encode({ type: 'multimodal', video: clip, audio: audioSamples })
          : await embeddingService.encodeVideo(clip.frames, clip.durationSec)

        // segment hash = hash(视频 hash + 时间区间)：同一视频文件被多处引用时可复用
        const segmentKey = `${video.fileHash}_${startMs}_${endMs}`
        const segmentHash = hasher(Buffer.from(segmentKey, 'utf8'))

        // 保存到 video_segments + video_segment_vecs
        this.db.saveVideoSegment(videoId, startMs, endMs, segmentHash, embedding)

      } catch (segmentError) {
        console.error(`Error processing segment ${i} of ${video.filePath}:`, segmentError)
        // 单片段失败 → 跳过，继续下一片段
      }
    }

    if (!modelReady) {
      throw new Error(`Embedding model not ready: ${embeddingService.getInitError() ?? 'unknown'}`)
    }

    // 更新视频元数据：frameCount 现在表示片段数而非帧数
    this.db.updateVideoMeta(videoId, { frameCount: numSegments })
  }

  private async processFace(fileHash: string, filePath: string): Promise<void> {
    try {
      if (this.db.hasFacesForHash(fileHash)) {
        this.db.updateFaceStatusByHash(fileHash)
        return
      }

      if (!isFaceServiceReady()) {
        await initFaceService()
      }

      const decoded = await decodeImage(filePath)
      const faces = await processPhotoFaces(decoded.buffer)

      for (const face of faces) {
        const faceId = this.db.saveFace(
          fileHash,
          face.faceIndex,
          JSON.stringify(face.bbox),
          face.confidence,
          face.embedding
        )

        assignFaceToPerson(this.db, faceId, face.embedding)
      }

      this.db.updateFaceStatusByHash(fileHash)
    } catch (error) {
      console.error(`Error processing faces for ${filePath}:`, error)
      throw error
    }
  }

  private async ensureThumbnailDir(): Promise<void> {
    if (!existsSync(this.thumbnailDir)) {
      await mkdir(this.thumbnailDir, { recursive: true })
    }
  }

  async preloadModels(): Promise<void> {
    if (this.modelsLoaded || this.modelsLoading) return
    this.modelsLoading = true
    try {
      await getEmbeddingService().init().catch(() => {})
      this.modelsLoaded = true
    } catch {
      // ignore preload failure
    } finally {
      this.modelsLoading = false
    }
  }

  /** 公开的进度发射（供 watcher 调用） */
  emitProgressPublic(): void {
    this.emitProgress('idle')
  }

  /** 获取缩略图路径（按 hash） */
  getThumbnailPath(fileHash: string): string {
    return join(this.thumbnailDir, `${fileHash}.webp`)
  }

  /** 获取某视频的帧 JPEG 输出目录（按视频 hash） */
  getVideoFramesDir(videoHash: string): string {
    return join(this.userDataPath, 'video_frames', videoHash)
  }

  async processNext(): Promise<void> {
    if (this.isProcessing || this.paused) return

    const task = this.db.getNextTask()
    if (!task) {
      this.emitProgress('idle')
      return
    }

    this.isProcessing = true

    try {
      // extract_frames 的 task.photoId 是 videos.id 而非 photos.id —— 单独处理
      if (task.taskType === 'extract_frames') {
        await this.processExtractFrames(task.photoId)
        this.db.completeTask(task.id)
      } else {
        const photo = this.db.getPhoto(task.photoId)
        if (!photo) {
          this.db.completeTask(task.id)
          this.isProcessing = false
          this.processNext()
          return
        }

        if (task.taskType === 'thumbnail') {
          this.emitProgress('indexing', photo.fileName)
          await this.processThumbnail(photo.fileHash, photo.filePath, task.photoId)
          this.db.completeTask(task.id)
        } else if (task.taskType === 'embed') {
          this.emitProgress('indexing', photo.fileName)
          await this.processEmbedding(photo.fileHash, photo.filePath, task.photoId)
          this.db.completeTask(task.id)
        } else if (task.taskType === 'face') {
          this.emitProgress('detecting_faces', photo.fileName)
          await this.processFace(photo.fileHash, photo.filePath)
          this.db.completeTask(task.id)
        } else if (task.taskType === 'ocr') {
          this.emitProgress('ocr', photo.fileName)
          await this.processOcr(photo.fileHash, photo.filePath)
          this.db.completeTask(task.id)
        }
      }
    } catch (error) {
      console.error(`Error processing task ${task.id}:`, error)
      this.db.failTask(task.id, String(error))
    }

    this.isProcessing = false
    this.emitProgress('idle')
    setImmediate(() => this.processNext())
  }

  private async processThumbnail(fileHash: string, filePath: string, photoId: number): Promise<void> {
    try {
      const decoded = await decodeImage(filePath)
      const thumbnailPath = this.getThumbnailPath(fileHash)
      if (existsSync(thumbnailPath)) {
        await this.parseAndUpdateMeta(photoId, decoded.buffer, decoded.originalBuffer)
        return
      }
      await this.parseAndUpdateMeta(photoId, decoded.buffer, decoded.originalBuffer)
      await this.generateThumbnail(fileHash, decoded.buffer)
    } catch (error) {
      console.error(`Error processing thumbnail for ${filePath}:`, error)
      throw error
    }
  }

  /**
   * EXIF/GPS 解析始终走 originalBuffer —— exifr 原生认 HEIC/RAW 元数据，
   * 转码后的 JPEG 反而会丢失拍摄时间和 GPS。sharp metadata 则用解码后的
   * 像素 buffer。
   */
  private async parseAndUpdateMeta(
    photoId: number,
    decodedBuffer: Buffer,
    originalBuffer: Buffer
  ): Promise<void> {
    const [metadata, exifData, gpsData] = await Promise.all([
      sharp(decodedBuffer).metadata(),
      exifr.parse(originalBuffer, {
        pick: ['Make', 'Model', 'ExposureTime', 'FNumber', 'ISO',
          'FocalLength', 'DateTimeOriginal'],
      }).catch(() => null),
      exifr.gps(originalBuffer).catch(() => null),
    ])

    this.db.updatePhotoMeta(photoId, {
      width: metadata.width,
      height: metadata.height,
      takenAt: exifData?.DateTimeOriginal?.toISOString(),
      lat: gpsData?.latitude,
      lng: gpsData?.longitude,
    })
  }

  private async processEmbedding(fileHash: string, filePath: string, photoId: number): Promise<void> {
    try {
      const { hasEmbedding } = this.db.hasContentForHash(fileHash)
      if (hasEmbedding) {
        this.db.updateEmbedStatusByHash(fileHash)
        return
      }

      const decoded = await decodeImage(filePath)

      // 兜底：确保缩略图存在
      const thumbnailPath = this.getThumbnailPath(fileHash)
      if (!existsSync(thumbnailPath)) {
        await this.processThumbnail(fileHash, filePath, photoId)
      }

      try {
        const embeddingService = getEmbeddingService()
        const embedding = await embeddingService.encodeImage(decoded.buffer)
        this.db.saveImageVec(fileHash, embedding)
      } catch (embedError) {
        console.warn(`Image embedding failed for ${filePath}:`, embedError)
      }
    } catch (error) {
      console.error(`Error processing embedding for ${filePath}:`, error)
      throw error
    }
  }

  private async generateThumbnail(fileHash: string, imageBuffer: Buffer): Promise<void> {
    const thumbnailPath = this.getThumbnailPath(fileHash)
    await sharp(imageBuffer)
      .rotate() // 按 EXIF orientation 自动旋转（修复 iPhone 竖拍）
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbnailPath)
  }

  private emitProgress(stage: IndexProgress['stage'], currentFile?: string): void {
    const photoStats = this.db.getPhotoStats()
    const progress: IndexProgress = {
      totalPhotos: photoStats.uniqueTotal,
      thumbnailedPhotos: photoStats.thumbnailed,
      indexedPhotos: photoStats.indexed,
      ocrPhotos: photoStats.ocred,
      stage,
      currentFile,
      paused: this.paused,
      aiModelReady: getEmbeddingService().isReady(),
    }
    this.emit('progress', progress)
  }
}
