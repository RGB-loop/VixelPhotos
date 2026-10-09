import { EventEmitter } from 'events'
import { basename, join } from 'path'
import { mkdir, rm, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import sharp from 'sharp'
import exifr from 'exifr'
import xxhash from 'xxhash-wasm'
import type { DatabaseInstance } from './db'
import type { CurrentTask, IndexProgress, TaskType } from '../shared/types'
import { getEmbeddingService } from './embedding'
import { initFaceService, isFaceServiceReady, processPhotoFaces, assignFaceToPerson } from './face'
import { initOcrService, isOcrReady, processPhotoOcr } from './ocr'
import { decodeImage, type DecodedImage } from './image/decode'
import { extractKeyframes, isFfmpegAvailable, probeDurationMs } from './video/extract'
import { generateSprite } from './video/sprite'
import { extractAudioTrack, extractCoverOrWaveform } from './audio/extract'
import { SEGMENT_MS } from './db'
import { FaceClusterer } from './face/clusterer'

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
 *   音频：extract_frames → 32s 片段（音轨）→ EmbeddingGemma 2 → video_segments；
 *         封面 / 波形图落成代表 photo（只做缩略图，不做图片向量）
 */
// 主进程里的 sharp（缩略图 / 元数据）默认用满所有核的 libuv 线程，后台索引时会挤占 UI；限 2 个
sharp.concurrency(2)

const PAUSED_KEY = 'indexing_paused'
/** 进度事件最小间隔：每次都要跑两条全表聚合（主进程同步），索引时每个任务 / 每个片段都会触发 */
const PROGRESS_MIN_INTERVAL_MS = 250
/** 模型未就绪导致的失败以此开头；requeueMissingEmbeddings 只自动重排这类，坏文件留给任务面板 */
export const MODEL_NOT_READY_PREFIX = 'Embedding model not ready'

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
  // 正在处理的任务，随 progress 事件推给任务面板
  private current: CurrentTask | null = null
  // 新脸先即时归属（只认很确定的），剩下的攒批聚类；人物有变动时发 'people-changed'
  readonly faceClusterer: FaceClusterer
  // 同一张图的 thumbnail → embed → face → ocr 任务通常相邻，复用最近两次解码（HEIC 走 sips 很贵）
  private decodeCache: Array<{ key: string; decoded: Promise<DecodedImage> }> = []
  private progressTimer: NodeJS.Timeout | null = null
  private lastProgressAt = 0
  private pendingProgress: { stage: IndexProgress['stage']; currentFile?: string } | null = null

  constructor(db: DatabaseInstance, userDataPath: string) {
    super()
    this.db = db
    this.userDataPath = userDataPath
    this.thumbnailDir = join(userDataPath, 'thumbnails')
    this.ensureThumbnailDir()
    // 持久化：暂停后退出应用，下次启动仍保持暂停
    this.paused = db.getMetaState(PAUSED_KEY) === '1'
    this.faceClusterer = new FaceClusterer(db, () => this.emit('people-changed'))
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

      const decoded = await this.decode(fileHash, filePath)
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
   * 处理 'extract_frames' 任务（视频和纯音频共用，按 media_kind 分支）：
   *   1. 按 32s 切片；视频片段 = 帧序列 + 音轨，音频片段 = 音轨 → Gemma2 → video_segments 表
   *   2. 代表图：视频取首帧，音频取内嵌封面或波形 → 代表 photo（网格 / 搜索落点）
   *
   * 视频帧写到 <userData>/video_frames/<videoHash>/ 供缩略图和调试，
   * 但不为每帧单独生成 photo 行 + image embedding；搜索直接走 video_segments。
   *
   * 返回值：部分片段失败时的说明（任务仍算完成），写进 index_queue.error_msg 供任务面板展示。
   */
  private async processExtractFrames(videoId: number): Promise<string | undefined> {
    const video = this.db.getVideoById(videoId)
    if (!video) return // 视频已被删除
    const kind = video.mediaKind

    if (!isFfmpegAvailable()) {
      throw new Error('ffmpeg binary not available — install ffmpeg-static or rebuild app')
    }

    this.setCurrent('extract_frames', kind, video.fileName, 0, 0)

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
        // 读不到时长 → 文件损坏 / 无效。frame_count=0 标记"扫过了"，并报错让任务面板可见
        this.db.updateVideoMeta(videoId, { frameCount: 0 })
        throw new Error('无法读取时长（文件损坏或格式不支持）')
      }
      this.db.updateVideoMeta(videoId, { durationMs })
    }

    // 模型没就绪时只落代表图（让媒体出现在网格里），然后抛错：
    // 否则每个片段都静默失败、任务却标 done，媒体永远没有片段向量。
    // 任务记 error，下次启动 requeueMissingEmbeddings 按"有时长、无片段"重新排队。
    const embeddingService = getEmbeddingService()
    await embeddingService.init()
    const modelReady = embeddingService.isReady()

    // 32s 片段，每 4s 一帧 → 8 帧。vision encoder 开销随帧数超线性增长：
    // 实测 M 系列 CPU 上 8 帧 ≈ 14s / 16 帧 ≈ 43s / 32 帧 ≈ 141s（峰值 3.9GB），
    // 1fps 对长视频不可用。8 帧 × 140 token + 32s 音频 ≈ 2K token，远低于 8K context
    const SEGMENT_DURATION_SEC = SEGMENT_MS / 1000
    const FRAME_INTERVAL_SEC = 4
    const numSegments = Math.max(1, Math.ceil(durationMs / SEGMENT_MS))
    this.setCurrent('extract_frames', kind, video.fileName, 0, numSegments)

    if (!existsSync(framesDir)) {
      await mkdir(framesDir, { recursive: true })
    }

    const hasher = await getXxhasher()

    // 代表图落成 photo 行：网格缩略图、搜索结果落点、"相似"入口。
    // 视频首帧也走图片 embed（requeueMissingEmbeddings 否则启动时还会补排）；
    // 音频封面/波形只做缩略图 —— 波形向量会污染图片搜索
    const addRepresentative = (buffer: Buffer, fileName: string): void => {
      const frameHash = hasher(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      const photoId = this.db.addPhoto(
        video.folderId, join(framesDir, fileName), fileName,
        buffer.byteLength, Date.now(), frameHash,
        { videoId, frameTimeMs: 0 }
      )
      this.db.addToQueue(photoId, 'thumbnail', 20)
      if (kind === 'audio') return
      if (this.db.hasContentForHash(frameHash).hasEmbedding) {
        this.db.updateEmbedStatusByHash(frameHash)
      } else {
        this.db.addToQueue(photoId, 'embed', 10)
      }
    }

    if (kind === 'audio') {
      // 封面和波形都失败 → 基本是坏文件，抛错让任务进失败列表
      const art = await extractCoverOrWaveform(video.filePath)
      const fileName = `${art.source}.jpg`
      await writeFile(join(framesDir, fileName), art.buffer)
      addRepresentative(art.buffer, fileName)
    }

    let failed = 0
    let lastError = ''
    for (let i = 0; i < numSegments; i++) {
      await this.waitIfPaused()
      // 长视频要跑很久，期间文件夹可能被移除
      if (!this.db.getVideoById(videoId)) return
      const segStartedAt = Date.now()
      const startMs = i * SEGMENT_MS
      const endMs = Math.min((i + 1) * SEGMENT_MS, durationMs)
      const segmentDurationSec = (endMs - startMs) / 1000

      try {
        let embedding: Float32Array | null = null
        if (kind === 'audio') {
          if (!modelReady) break
          const samples = await extractAudioTrack(video.filePath, {
            startSec: startMs / 1000,
            durationSec: segmentDurationSec,
          })
          if (samples.length > 0) {
            embedding = await embeddingService.encode({ type: 'audio', samples })
          }
        } else {
          const frames = await extractKeyframes(video.filePath, {
            startSec: startMs / 1000,
            durationSec: segmentDurationSec,
            intervalSec: FRAME_INTERVAL_SEC,
            maxFrames: SEGMENT_DURATION_SEC / FRAME_INTERVAL_SEC,
            maxSide: 512,
          })
          // 空片段 / 损坏部分 → 跳过，不保存 segment 行
          if (frames.length > 0) {
            // 首段首帧先落成代表 photo —— 放在编码之前，
            // 这样即便模型没就绪 / 编码失败，视频依然出现在网格里。
            if (i === 0) {
              const firstFrameFileName = `segment_${i}_0ms.jpg`
              await writeFile(join(framesDir, firstFrameFileName), frames[0].buffer)
              addRepresentative(frames[0].buffer, firstFrameFileName)
            }
            if (!modelReady) break
            embedding = await this.encodeVideoSegment(video.filePath, frames.map((f) => f.buffer), startMs, segmentDurationSec, i)
          }
        }

        if (embedding) {
          // segment hash = hash(媒体 hash + 时间区间)：同一文件被多处引用时可复用
          const segmentKey = `${video.fileHash}_${startMs}_${endMs}`
          const segmentHash = hasher(Buffer.from(segmentKey, 'utf8'))
          this.db.saveVideoSegment(videoId, startMs, endMs, segmentHash, embedding)
        }
      } catch (segmentError) {
        console.error(`Error processing segment ${i} of ${video.filePath}:`, segmentError)
        // 单片段失败 → 跳过，继续下一片段
        failed++
        lastError = String(segmentError)
      }
      this.setCurrent('extract_frames', kind, video.fileName, i + 1, numSegments, Date.now() - segStartedAt)
    }

    // 悬停拖动预览的 sprite：放在片段之后，不推迟视频出现在网格里；失败不影响索引
    // （渲染端拿不到 sprite 会回退到播放预览，老视频由 vixel://sprite 按需补生成）
    if (kind === 'video' && this.db.getVideoById(videoId)) {
      try {
        await generateSprite(video.filePath, durationMs, this.getSpritePath(video.fileHash))
      } catch (spriteError) {
        console.warn(`Sprite generation failed for ${video.filePath}:`, spriteError)
      }
    }

    if (!modelReady) {
      throw new Error(`${MODEL_NOT_READY_PREFIX}: ${embeddingService.getInitError() ?? 'unknown'}`)
    }
    if (failed === numSegments) {
      throw new Error(`全部 ${numSegments} 个片段失败：${lastError.slice(0, 300)}`)
    }

    // 更新元数据：frameCount 现在表示片段数而非帧数
    this.db.updateVideoMeta(videoId, { frameCount: numSegments })
    return failed > 0 ? `${failed}/${numSegments} 个片段失败：${lastError.slice(0, 200)}` : undefined
  }

  /** 视频片段：帧序列 + 音轨 → 单向量；无音轨时退化为纯视觉 */
  private async encodeVideoSegment(
    filePath: string,
    frames: Buffer[],
    startMs: number,
    durationSec: number,
    index: number
  ): Promise<Float32Array> {
    const embeddingService = getEmbeddingService()
    let audioSamples: Float32Array | null = null
    try {
      audioSamples = await extractAudioTrack(filePath, { startSec: startMs / 1000, durationSec })
    } catch (audioError) {
      // 无音轨 / 损坏音频 → 仅视觉模态继续
      console.warn(`Audio extraction failed for segment ${index} of ${filePath}:`, audioError)
    }
    const clip = { frames, durationSec }
    return audioSamples && audioSamples.length > 0
      ? embeddingService.encode({ type: 'multimodal', video: clip, audio: audioSamples })
      : embeddingService.encodeVideo(clip.frames, clip.durationSec)
  }

  private setCurrent(
    taskType: TaskType,
    kind: CurrentTask['kind'],
    name: string,
    segDone: number,
    segTotal: number,
    lastSegMs?: number
  ): void {
    const startedAt = this.current?.name === name && this.current.taskType === taskType
      ? this.current.startedAt
      : Date.now()
    this.current = { taskType, kind, name, segDone, segTotal, startedAt, lastSegMs }
    const stage = taskType === 'ocr' ? 'ocr' : taskType === 'face' ? 'detecting_faces' : 'indexing'
    this.emitProgress(stage, name)
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

      const decoded = await this.decode(fileHash, filePath)
      const faces = await processPhotoFaces(decoded.buffer)

      for (const face of faces) {
        const faceId = this.db.saveFace(
          fileHash,
          face.faceIndex,
          JSON.stringify(face.bbox),
          face.confidence,
          face.embedding,
          face.quality
        )

        assignFaceToPerson(this.db, faceId, face.embedding, face.quality)
      }

      this.db.updateFaceStatusByHash(fileHash)
      if (faces.length > 0) this.faceClusterer.schedule()
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

  /** 诊断用：当前任务的简短描述 */
  currentTaskLabel(): string | undefined {
    return this.current ? `${this.current.taskType} ${this.current.name}` : undefined
  }

  /** 公开的进度发射（供 watcher 调用） */
  emitProgressPublic(): void {
    this.emitProgress(this.isProcessing ? 'indexing' : 'idle', this.current?.name)
  }

  private decode(fileHash: string, filePath: string): Promise<DecodedImage> {
    const key = `${fileHash}:${filePath}`
    const hit = this.decodeCache.find((e) => e.key === key)
    if (hit) return hit.decoded
    const decoded = decodeImage(filePath)
    // 失败的不缓存，重试时重新读
    decoded.catch(() => { this.decodeCache = this.decodeCache.filter((e) => e.decoded !== decoded) })
    this.decodeCache = [{ key, decoded }, ...this.decodeCache].slice(0, 2)
    return decoded
  }

  /** 获取缩略图路径（按 hash） */
  getThumbnailPath(fileHash: string): string {
    return join(this.thumbnailDir, `${fileHash}.webp`)
  }

  /** 获取某视频的帧 JPEG 输出目录（按视频 hash） */
  getVideoFramesDir(videoHash: string): string {
    return join(this.userDataPath, 'video_frames', videoHash)
  }

  /** 悬停拖动预览的 sprite（与抽帧同目录，重新索引时一起清掉） */
  getSpritePath(videoHash: string): string {
    return join(this.getVideoFramesDir(videoHash), 'sprite.jpg')
  }

  async processNext(): Promise<void> {
    if (this.isProcessing || this.paused) return

    const task = this.db.getNextTask()
    if (!task) {
      this.current = null
      this.emitProgress('idle')
      return
    }

    this.isProcessing = true

    try {
      // extract_frames 的 task.photoId 是 videos.id 而非 photos.id —— 单独处理
      if (task.taskType === 'extract_frames') {
        const note = await this.processExtractFrames(task.photoId)
        this.db.completeTask(task.id, note)
      } else {
        const photo = this.db.getPhoto(task.photoId)
        if (!photo) {
          this.db.completeTask(task.id)
          this.isProcessing = false
          this.processNext()
          return
        }

        this.setCurrent(task.taskType as TaskType, photo.mediaKind ?? 'image', photo.fileName, 0, 1)
        if (task.taskType === 'thumbnail') {
          await this.processThumbnail(photo.fileHash, photo.filePath, task.photoId, photo.width != null)
        } else if (task.taskType === 'embed') {
          await this.processEmbedding(photo.fileHash, photo.filePath, task.photoId)
        } else if (task.taskType === 'face') {
          await this.processFace(photo.fileHash, photo.filePath)
        } else if (task.taskType === 'ocr') {
          await this.processOcr(photo.fileHash, photo.filePath)
        }
        this.db.completeTask(task.id)
      }
    } catch (error) {
      console.error(`Error processing task ${task.id}:`, error)
      this.db.failTask(task.id, error instanceof Error ? error.message : String(error))
    }

    this.isProcessing = false
    this.current = null
    this.emitProgress('idle')
    setImmediate(() => this.processNext())
  }

  private async processThumbnail(fileHash: string, filePath: string, photoId: number, hasMeta = false): Promise<void> {
    try {
      const thumbnailPath = this.getThumbnailPath(fileHash)
      const hasThumb = existsSync(thumbnailPath)
      // 缩略图和元数据都在 → 不必再解码原图
      if (hasThumb && hasMeta) return
      const decoded = await this.decode(fileHash, filePath)
      await this.parseAndUpdateMeta(photoId, decoded.buffer, decoded.originalBuffer)
      if (!hasThumb) await this.generateThumbnail(fileHash, decoded.buffer)
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

      // 兜底：确保缩略图存在（与下面共用同一次解码）
      if (!existsSync(this.getThumbnailPath(fileHash))) {
        await this.processThumbnail(fileHash, filePath, photoId)
      }
      const decoded = await this.decode(fileHash, filePath)

      // 失败要抛出：吞掉的话任务记 done、没有向量，下次启动又被 requeueMissingEmbeddings 悄悄重排
      const embeddingService = getEmbeddingService()
      await embeddingService.init()
      if (!embeddingService.isReady()) {
        throw new Error(`${MODEL_NOT_READY_PREFIX}: ${embeddingService.getInitError() ?? 'unknown'}`)
      }
      const embedding = await embeddingService.encodeImage(decoded.buffer)
      this.db.saveImageVec(fileHash, embedding)
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

  /**
   * 合并发送：间隔内的多次调用只发最后一次（尾沿一定会发出，最终状态不丢）。
   * 统计查询放在真正发送时才跑，索引时主进程不再被逐任务的全表聚合占住。
   */
  private emitProgress(stage: IndexProgress['stage'], currentFile?: string): void {
    this.pendingProgress = { stage, currentFile }
    if (this.progressTimer) return
    const wait = PROGRESS_MIN_INTERVAL_MS - (Date.now() - this.lastProgressAt)
    if (wait <= 0) this.flushProgress()
    else this.progressTimer = setTimeout(() => this.flushProgress(), wait)
  }

  private flushProgress(): void {
    this.progressTimer = null
    const pending = this.pendingProgress
    if (!pending) return
    this.pendingProgress = null
    this.lastProgressAt = Date.now()
    const photoStats = this.db.getPhotoStats()
    const queue = this.db.getQueueStats()
    const progress: IndexProgress = {
      totalPhotos: photoStats.uniqueTotal,
      thumbnailedPhotos: photoStats.thumbnailed,
      indexedPhotos: photoStats.indexed,
      ocrPhotos: photoStats.ocred,
      stage: pending.stage,
      currentFile: pending.currentFile,
      paused: this.paused,
      current: this.current ?? undefined,
      queue: { pending: queue.pending + queue.processing, error: queue.error },
      aiModelReady: getEmbeddingService().isReady(),
    }
    this.emit('progress', progress)
  }
}
