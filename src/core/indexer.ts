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
import { extractKeyframes, isFfmpegAvailable } from './video/extract'

// xxHash 懒加载（与 watcher 共用语义；模块级单例避免重复 init）
let _hasher: ((input: Uint8Array) => string) | null = null
async function getXxhasher(): Promise<(input: Uint8Array) => string> {
  if (_hasher) return _hasher
  const h = await xxhash()
  _hasher = (data: Uint8Array) => h.h64Raw(data).toString(16).padStart(16, '0')
  return _hasher
}

/**
 * Indexer 流水线（v0.2，纯本地，无 LLM）：
 *   thumbnail → embed (SigLIP 2) → face (按需)
 *
 * caption 由用户手动编辑或后续 OCR (PR3) 填充；此处不再生成。
 */
export class Indexer extends EventEmitter {
  private db: DatabaseInstance
  private userDataPath: string
  private thumbnailDir: string
  private isProcessing = false
  private modelsLoaded = false
  private modelsLoading = false

  constructor(db: DatabaseInstance, userDataPath: string) {
    super()
    this.db = db
    this.userDataPath = userDataPath
    this.thumbnailDir = join(userDataPath, 'thumbnails')
    this.ensureThumbnailDir()
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
          // 没装 OCR 模型：不抛错，静默跳过（caption FTS5 + vec 仍可用）
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
   * 处理 'extract_frames' 任务：用 ffmpeg 抽 N 帧 → 写到
   * <userData>/video_frames/<videoHash>/<frameTimeMs>.jpg
   * → 每帧 addPhoto + 入 thumbnail/embed 队列。
   *
   * 帧本身有 file_path（存在磁盘上），所以下游 thumbnail/embed/ocr/face
   * 流水线无任何修改照样跑。
   */
  private async processExtractFrames(videoId: number): Promise<void> {
    const video = this.db.getVideoById(videoId)
    if (!video) return // 视频已被删除

    if (!isFfmpegAvailable()) {
      throw new Error('ffmpeg binary not available — install ffmpeg-static or rebuild app')
    }

    this.emitProgress('indexing', basename(video.filePath))

    // 清掉该视频上一轮抽的帧（DB 行 + 孤立 hash 的内容 GC + 共享缩略图）
    // 然后再 rm 整个 framesDir，确保磁盘和 DB 状态一致。
    // 首次抽帧时 removeFramesForVideo 返回空，相当于 no-op。
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

    const frames = await extractKeyframes(video.filePath, {})
    if (frames.length === 0) {
      // 空视频 / 损坏；标记 frame_count=0 让搜索界面知道这个视频确实扫过了但没内容
      this.db.updateVideoMeta(videoId, { frameCount: 0 })
      return
    }

    if (!existsSync(framesDir)) {
      await mkdir(framesDir, { recursive: true })
    }

    const hasher = await getXxhasher()

    for (const frame of frames) {
      const frameFileName = `${frame.timestampMs}.jpg`
      const framePath = join(framesDir, frameFileName)
      // 帧 hash 用 JPEG 字节，做内容级 dedup（同一帧出现在两个视频里也共享 embedding）
      const frameHash = hasher(new Uint8Array(frame.buffer.buffer, frame.buffer.byteOffset, frame.buffer.byteLength))

      // 已存在的帧（如：之前部分跑完崩了再重试）跳过写盘
      if (!existsSync(framePath)) {
        await writeFile(framePath, frame.buffer)
      }

      const photoId = this.db.addPhoto(
        video.folderId, framePath, frameFileName,
        frame.buffer.byteLength, Date.now(), frameHash,
        { videoId, frameTimeMs: frame.timestampMs }
      )

      // dedup：同内容的帧已有 embedding 就直接复用
      const { hasEmbedding } = this.db.hasContentForHash(frameHash)
      if (hasEmbedding) {
        this.db.updateEmbedStatusByHash(frameHash)
        this.db.addToQueue(photoId, 'thumbnail', 20)
      } else {
        this.db.addToQueue(photoId, 'thumbnail', 20)
        this.db.addToQueue(photoId, 'embed', 10)
      }
    }

    this.db.updateVideoMeta(videoId, { frameCount: frames.length })
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
    if (this.isProcessing) return

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
        } else if (task.taskType === 'caption') {
          // legacy 队列条目：直接 drop（v0.2 不再生成 caption）
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
      captionedPhotos: photoStats.captioned,
      ocrPhotos: photoStats.ocred,
      stage,
      currentFile,
      aiModelReady: getEmbeddingService().isReady(),
    }
    this.emit('progress', progress)
  }
}
