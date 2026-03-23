import { EventEmitter } from 'events'
import { join } from 'path'
import { mkdir, readFile } from 'fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { app } from 'electron'
import sharp from 'sharp'
import exifr from 'exifr'
import type { DatabaseInstance } from '../db'
import type { IndexProgress, CaptionLanguage, CaptionConfig } from '../../shared/types'
import { getEmbeddingService } from './embedding'
import { getLlamaServerManager } from './llama/serverManager'

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

  /** 读取 caption 语言配置 */
  getCaptionConfig(): CaptionConfig {
    try {
      const configPath = join(app.getPath('userData'), 'caption-config.json')
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return { language: 'en' }
  }

  /** 保存 caption 语言配置 */
  setCaptionConfig(config: CaptionConfig): void {
    const configPath = join(app.getPath('userData'), 'caption-config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2))
  }

  private getCaptionPrompt(lang: CaptionLanguage): { system: string; user: string } {
    if (lang === 'zh') {
      return {
        system: '你是一个图片描述助手。只输出描述内容，不要解释。',
        user: '用一句详细的中文描述这张图片。',
      }
    }
    return {
      system: 'You are an image captioning assistant. Respond with only the caption, no explanations.',
      user: 'Describe this image in one detailed sentence.',
    }
  }

  /** 为指定 hash 重新生成 caption（公开方法，供 IPC 调用） */
  async regenerateCaption(fileHash: string, filePath: string): Promise<string | null> {
    const manager = getLlamaServerManager()
    await manager.ensureModel('caption')

    const imageBuffer = await readFile(filePath)
    const base64Image = imageBuffer.toString('base64')
    const mimeType = this.detectMimeType(imageBuffer)
    const { language } = this.getCaptionConfig()
    const prompt = this.getCaptionPrompt(language)

    const response = await manager.chatCompletion({
      model: 'qwen3.5-4b',
      messages: [
        { role: 'system', content: prompt.system },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: 'text', text: prompt.user },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.3,
    })

    const message = response.choices[0]?.message
    let caption = message?.content?.trim()
    if (!caption && message?.reasoning_content) {
      caption = this.extractCaptionFromReasoning(message.reasoning_content)
    }
    if (caption) {
      caption = this.stripThinkingContent(caption)
    }
    if (!caption) return null

    this.db.saveCaption(fileHash, caption)
    console.log(`Caption regenerated: hash=${fileHash} -> "${caption}"`)
    return caption
  }

  private async ensureThumbnailDir(): Promise<void> {
    if (!existsSync(this.thumbnailDir)) {
      await mkdir(this.thumbnailDir, { recursive: true })
    }
  }

  async preloadModels(): Promise<void> {
    if (this.modelsLoaded || this.modelsLoading) return
    this.modelsLoading = true
    console.log('Preloading AI models...')
    try {
      await getEmbeddingService().init().catch((e) => {
        console.warn('Embedding service init failed:', e)
      })
      this.modelsLoaded = true
      console.log('AI models preloaded')
    } catch (error) {
      console.error('Failed to preload models:', error)
    } finally {
      this.modelsLoading = false
    }
  }

  private isCaptionModelReady(): boolean {
    try {
      return getLlamaServerManager().isModelLoaded('caption')
    } catch {
      return false
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

    console.log(`processNext: task ${task.id} (${task.taskType}) for photo ${task.photoId}`)
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
        console.log(`Thumbnail: ${photo.fileName}`)
        this.emitProgress('indexing', photo.fileName)
        await this.processThumbnail(photo.fileHash, photo.filePath, task.photoId)
        this.db.completeTask(task.id)
      } else if (task.taskType === 'embed') {
        console.log(`Embedding: ${photo.fileName}`)
        this.emitProgress('indexing', photo.fileName)
        await this.processEmbedding(photo.fileHash, photo.filePath, task.photoId)
        console.log(`Embedding done: ${photo.fileName}`)
        if (photo.captionStatus !== 'done') {
          this.db.addToQueue(task.photoId, 'caption', 5)
        }
        this.db.completeTask(task.id)
      } else if (task.taskType === 'caption') {
        const nextTask = this.db.peekNextTask()
        if (nextTask && nextTask.taskType === 'embed') {
          this.db.resetTask(task.id)
          this.isProcessing = false
          setImmediate(() => this.processNext())
          return
        }
        this.emitProgress('captioning', photo.fileName)
        await this.processCaption(photo.fileHash, photo.filePath)
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
      // 如果该 hash 的缩略图已存在，跳过
      const thumbnailPath = this.getThumbnailPath(fileHash)
      if (existsSync(thumbnailPath)) {
        console.log(`  Thumbnail already exists for hash ${fileHash}, skipping`)
        // 但仍需解析 EXIF 更新当前 photo 的元数据
        const imageBuffer = await readFile(filePath)
        await this.parseAndUpdateMeta(photoId, imageBuffer)
        return
      }

      console.log(`  Reading file: ${filePath}`)
      const imageBuffer = await readFile(filePath)

      await this.parseAndUpdateMeta(photoId, imageBuffer)

      console.log(`  Generating thumbnail (hash=${fileHash})...`)
      await this.generateThumbnail(fileHash, imageBuffer)
    } catch (error) {
      console.error(`Error processing thumbnail for ${filePath}:`, error)
      throw error
    }
  }

  private async parseAndUpdateMeta(photoId: number, imageBuffer: Buffer): Promise<void> {
    console.log(`  Parsing EXIF...`)
    const [metadata, exifData] = await Promise.all([
      sharp(imageBuffer).metadata(),
      exifr.parse(imageBuffer, {
        pick: ['Make', 'Model', 'ExposureTime', 'FNumber', 'ISO',
          'FocalLength', 'DateTimeOriginal', 'GPSLatitude', 'GPSLongitude'],
      }).catch(() => null),
    ])

    this.db.updatePhotoMeta(photoId, {
      width: metadata.width,
      height: metadata.height,
      takenAt: exifData?.DateTimeOriginal?.toISOString(),
      lat: exifData?.GPSLatitude,
      lng: exifData?.GPSLongitude,
    })
  }

  private async processEmbedding(fileHash: string, filePath: string, photoId: number): Promise<void> {
    try {
      // 如果该 hash 已有 embedding，跳过
      const { hasEmbedding } = this.db.hasContentForHash(fileHash)
      if (hasEmbedding) {
        console.log(`  Embedding already exists for hash ${fileHash}, skipping`)
        this.db.updateEmbedStatusByHash(fileHash)
        return
      }

      console.log(`  Reading file: ${filePath}`)
      const imageBuffer = await readFile(filePath)

      // 兜底：确保缩略图存在
      const thumbnailPath = this.getThumbnailPath(fileHash)
      if (!existsSync(thumbnailPath)) {
        await this.processThumbnail(fileHash, filePath, photoId)
      }

      console.log(`  Generating embedding...`)
      try {
        const embeddingService = getEmbeddingService()
        const embedding = await embeddingService.encodeImage(imageBuffer)
        this.db.saveImageVec(fileHash, embedding)
        console.log(`  Embedding saved (dim=${embedding.length}, hash=${fileHash})`)
      } catch (embedError) {
        console.warn(`Image embedding failed for ${filePath}:`, embedError)
      }
    } catch (error) {
      console.error(`Error processing embedding for ${filePath}:`, error)
      throw error
    }
  }

  private async processCaption(fileHash: string, filePath: string): Promise<void> {
    try {
      // 如果该 hash 已有 caption，跳过
      const { hasCaption } = this.db.hasContentForHash(fileHash)
      if (hasCaption) {
        console.log(`  Caption already exists for hash ${fileHash}, skipping`)
        this.db.updateCaptionStatusByHash(fileHash)
        return
      }

      const manager = getLlamaServerManager()
      await manager.ensureModel('caption')

      const imageBuffer = await readFile(filePath)
      const base64Image = imageBuffer.toString('base64')
      const mimeType = this.detectMimeType(imageBuffer)
      const { language } = this.getCaptionConfig()
      const prompt = this.getCaptionPrompt(language)

      const response = await manager.chatCompletion({
        model: 'qwen3.5-4b',
        messages: [
          { role: 'system', content: prompt.system },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
              { type: 'text', text: prompt.user },
            ],
          },
        ],
        max_tokens: 512,
        temperature: 0.3,
      })

      const message = response.choices[0]?.message
      let caption = message?.content?.trim()

      if (!caption && message?.reasoning_content) {
        caption = this.extractCaptionFromReasoning(message.reasoning_content)
      }

      if (!caption) {
        console.warn(`No caption generated for ${filePath}`)
        return
      }

      caption = this.stripThinkingContent(caption)
      if (!caption) {
        console.warn(`No caption after stripping thinking for ${filePath}`)
        return
      }

      this.db.saveCaption(fileHash, caption)
      console.log(`Caption saved: hash=${fileHash} -> "${caption}"`)
    } catch (error) {
      console.error(`Error processing caption for ${filePath}:`, error)
      throw error
    }
  }

  private stripThinkingContent(content: string): string {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  }

  private extractCaptionFromReasoning(reasoning: string): string {
    const lines = reasoning.split('\n')
    const descriptions: string[] = []
    for (const line of lines) {
      if (line.includes('subject:') || line.includes('outfit:') ||
          line.includes('setting:') || line.includes('background:')) {
        const match = line.match(/:\s*(.+)/)
        if (match && match[1]) descriptions.push(match[1].trim())
      }
    }
    if (descriptions.length > 0) return descriptions.join(' ').replace(/\*\*/g, '').trim()
    const cleaned = reasoning.replace(/\*\*/g, '').replace(/\n+/g, ' ').trim()
    return cleaned.length > 200 ? cleaned.substring(0, 200) + '...' : cleaned
  }

  private detectMimeType(buffer: Buffer): string {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
    if (buffer[8] === 0x57 && buffer[9] === 0x45) return 'image/webp'
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif'
    return 'image/jpeg'
  }

  private async generateThumbnail(fileHash: string, imageBuffer: Buffer): Promise<void> {
    const thumbnailPath = this.getThumbnailPath(fileHash)
    await sharp(imageBuffer)
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
      stage,
      currentFile,
      aiModelReady: getEmbeddingService().isReady(),
    }
    this.emit('progress', progress)
  }
}
