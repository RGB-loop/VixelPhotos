import { EventEmitter } from 'events'
import { join } from 'path'
import { mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import sharp from 'sharp'
import exifr from 'exifr'
import type { DatabaseInstance } from '../db'
import type { IndexProgress } from '../../shared/types'
import { getImageEmbedding } from './imageEmbedding'
import { getTextEmbedding } from './textEmbedding'
import { getCaptionGenerator } from './captionGenerator'

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

    // 确保缩略图目录存在
    this.ensureThumbnailDir()
  }

  private async ensureThumbnailDir(): Promise<void> {
    if (!existsSync(this.thumbnailDir)) {
      await mkdir(this.thumbnailDir, { recursive: true })
    }
  }

  /**
   * 预加载 AI 模型
   */
  async preloadModels(): Promise<void> {
    if (this.modelsLoaded || this.modelsLoading) return

    this.modelsLoading = true
    console.log('Preloading AI models...')

    try {
      // 并行加载模型
      await Promise.all([
        getImageEmbedding().init().catch((e) => console.warn('Image embedding init failed:', e)),
        getTextEmbedding().init().catch((e) => console.warn('Text embedding init failed:', e)),
        getCaptionGenerator().init().catch((e) => console.warn('Caption generator init failed:', e)),
      ])

      this.modelsLoaded = true
      console.log('AI models preloaded')
    } catch (error) {
      console.error('Failed to preload models:', error)
    } finally {
      this.modelsLoading = false
    }
  }

  /**
   * 处理下一个任务
   */
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

      if (task.taskType === 'embed') {
        this.emitProgress('embedding', photo.fileName)
        await this.processEmbedding(task.photoId, photo.filePath)
        // 完成 embedding 后，添加 caption 任务（低优先级）
        this.db.addToQueue(task.photoId, 'caption', 5)
      } else if (task.taskType === 'caption') {
        this.emitProgress('captioning', photo.fileName)
        await this.processCaption(task.photoId, photo.filePath)
      }

      this.db.completeTask(task.id)
    } catch (error) {
      console.error(`Error processing task ${task.id}:`, error)
      this.db.failTask(task.id, String(error))
    }

    this.isProcessing = false
    this.emitProgress('idle')

    // 处理下一个任务
    setImmediate(() => this.processNext())
  }

  /**
   * 处理图像 Embedding
   */
  private async processEmbedding(photoId: number, filePath: string): Promise<void> {
    try {
      // 读取图像文件
      const imageBuffer = await readFile(filePath)

      // 1. 解析 EXIF
      const [metadata, exifData] = await Promise.all([
        sharp(imageBuffer).metadata(),
        exifr
          .parse(imageBuffer, {
            pick: [
              'Make',
              'Model',
              'ExposureTime',
              'FNumber',
              'ISO',
              'FocalLength',
              'DateTimeOriginal',
              'GPSLatitude',
              'GPSLongitude',
            ],
          })
          .catch(() => null),
      ])

      // 更新照片元数据
      this.db.updatePhotoMeta(photoId, {
        width: metadata.width,
        height: metadata.height,
        takenAt: exifData?.DateTimeOriginal?.toISOString(),
        lat: exifData?.GPSLatitude,
        lng: exifData?.GPSLongitude,
      })

      // 2. 生成缩略图
      await this.generateThumbnail(photoId, imageBuffer)

      // 3. 生成图像 Embedding
      try {
        const imageEmbedding = getImageEmbedding()
        const embedding = await imageEmbedding.encode(imageBuffer)
        this.db.saveImageVec(photoId, embedding)
        console.log(`Indexed image embedding: ${filePath}`)
      } catch (embedError) {
        console.warn(`Image embedding failed for ${filePath}:`, embedError)
        // 即使 embedding 失败也标记为完成，避免无限重试
        // 可以使用默认/随机向量或跳过
      }
    } catch (error) {
      console.error(`Error processing embedding for ${filePath}:`, error)
      throw error
    }
  }

  /**
   * 处理 Caption 生成
   */
  private async processCaption(photoId: number, filePath: string): Promise<void> {
    try {
      const captionGenerator = getCaptionGenerator()

      // 检查 caption 生成器是否可用
      if (!captionGenerator.isAvailable()) {
        console.log(`Caption generator not available, skipping: ${filePath}`)
        return
      }

      const imageBuffer = await readFile(filePath)

      // 1. 生成 Caption
      const caption = await captionGenerator.generate(imageBuffer)

      if (!caption) {
        console.warn(`No caption generated for ${filePath}`)
        return
      }

      // 保存 Caption 文本
      this.db.saveCaption(photoId, caption)

      // 2. 生成 Caption Embedding
      try {
        const textEmbedding = getTextEmbedding()
        const embedding = await textEmbedding.encodePassage(caption)
        this.db.saveCaptionVec(photoId, embedding)
        console.log(`Indexed caption: ${filePath} -> "${caption}"`)
      } catch (embedError) {
        console.warn(`Caption embedding failed for ${filePath}:`, embedError)
      }
    } catch (error) {
      console.error(`Error processing caption for ${filePath}:`, error)
      throw error
    }
  }

  /**
   * 生成缩略图
   */
  private async generateThumbnail(photoId: number, imageBuffer: Buffer): Promise<void> {
    const thumbnailPath = join(this.thumbnailDir, `${photoId}.webp`)

    await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toFile(thumbnailPath)
  }

  /**
   * 发送进度事件
   */
  private emitProgress(stage: IndexProgress['stage'], currentFile?: string): void {
    const stats = this.db.getQueueStats()

    const progress: IndexProgress = {
      total: stats.pending + stats.processing + stats.done,
      done: stats.done,
      currentFile,
      stage,
    }

    this.emit('progress', progress)
  }
}
