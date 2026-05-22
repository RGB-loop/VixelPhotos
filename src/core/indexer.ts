import { EventEmitter } from 'events'
import { join } from 'path'
import { mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import sharp from 'sharp'
import exifr from 'exifr'
import type { DatabaseInstance } from './db'
import type { IndexProgress } from '../shared/types'
import { getEmbeddingService } from './embedding'
import { initFaceService, isFaceServiceReady, processPhotoFaces, assignFaceToPerson } from './face'

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

  private async processFace(fileHash: string, filePath: string): Promise<void> {
    try {
      if (this.db.hasFacesForHash(fileHash)) {
        this.db.updateFaceStatusByHash(fileHash)
        return
      }

      if (!isFaceServiceReady()) {
        await initFaceService()
      }

      const imageBuffer = await readFile(filePath)
      const faces = await processPhotoFaces(imageBuffer)

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

  async processNext(): Promise<void> {
    if (this.isProcessing) return

    const task = this.db.getNextTask()
    if (!task) {
      this.emitProgress('idle')
      return
    }

    this.isProcessing = true

    try {
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
      } else if (task.taskType === 'caption') {
        // legacy 队列条目：直接 drop（v0.2 不再生成 caption）
        this.db.completeTask(task.id)
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
      const thumbnailPath = this.getThumbnailPath(fileHash)
      if (existsSync(thumbnailPath)) {
        const imageBuffer = await readFile(filePath)
        await this.parseAndUpdateMeta(photoId, imageBuffer)
        return
      }

      const imageBuffer = await readFile(filePath)

      await this.parseAndUpdateMeta(photoId, imageBuffer)
      await this.generateThumbnail(fileHash, imageBuffer)
    } catch (error) {
      console.error(`Error processing thumbnail for ${filePath}:`, error)
      throw error
    }
  }

  private async parseAndUpdateMeta(photoId: number, imageBuffer: Buffer): Promise<void> {
    const [metadata, exifData, gpsData] = await Promise.all([
      sharp(imageBuffer).metadata(),
      exifr.parse(imageBuffer, {
        pick: ['Make', 'Model', 'ExposureTime', 'FNumber', 'ISO',
          'FocalLength', 'DateTimeOriginal'],
      }).catch(() => null),
      exifr.gps(imageBuffer).catch(() => null),
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

      const imageBuffer = await readFile(filePath)

      // 兜底：确保缩略图存在
      const thumbnailPath = this.getThumbnailPath(fileHash)
      if (!existsSync(thumbnailPath)) {
        await this.processThumbnail(fileHash, filePath, photoId)
      }

      try {
        const embeddingService = getEmbeddingService()
        const embedding = await embeddingService.encodeImage(imageBuffer)
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
      captionedPhotos: photoStats.captioned, // 字段保留为 0（未来 OCR 填）
      stage,
      currentFile,
      aiModelReady: getEmbeddingService().isReady(),
    }
    this.emit('progress', progress)
  }
}
