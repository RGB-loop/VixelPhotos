import chokidar, { type FSWatcher } from 'chokidar'
import { basename, extname } from 'path'
import { stat, readFile, access } from 'fs/promises'
import xxhash from 'xxhash-wasm'
import type { DatabaseInstance } from './db'
import type { Indexer } from './indexer'

// xxHash 实例（懒初始化）
let hashFn: ((input: Uint8Array) => string) | null = null
async function getHasher(): Promise<(input: Uint8Array) => string> {
  if (!hashFn) {
    const hasher = await xxhash()
    // h64Raw 接受 Uint8Array 返回 bigint，转 16 位 hex
    hashFn = (data: Uint8Array) => {
      const raw = hasher.h64Raw(data)
      return raw.toString(16).padStart(16, '0')
    }
  }
  return hashFn
}

// 支持的图片格式
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tiff', '.tif',
  '.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.avif',
])

// 支持的视频格式（实际能不能解码取决于 ffmpeg-static；这些是最常见的）
const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi',
])

type MediaKind = 'image' | 'video' | null

function classifyMedia(filePath: string): MediaKind {
  const ext = extname(filePath).toLowerCase()
  if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (SUPPORTED_VIDEO_EXTENSIONS.has(ext)) return 'video'
  return null
}

export class FileWatcher {
  private watchers: Map<number, FSWatcher> = new Map()
  private db: DatabaseInstance
  private indexer: Indexer

  constructor(db: DatabaseInstance, indexer: Indexer) {
    this.db = db
    this.indexer = indexer
  }

  watchFolder(folderId: number, folderPath: string): void {
    if (this.watchers.has(folderId)) {
      return
    }

    console.log(`Starting to watch folder: ${folderPath}`)

    const watcher = chokidar.watch(folderPath, {
      ignored: [/(^|[\/\\])\./, /node_modules/, /\.git/],
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      depth: 99,
    })

    watcher
      .on('add', (filePath) => this.handleAdd(folderId, filePath))
      .on('change', (filePath) => this.handleChange(filePath))
      .on('unlink', (filePath) => this.handleRemove(filePath))
      .on('ready', () => {
        this.db.updateFolderScanTime(folderId)
        // 清理离线期间被删除的文件
        this.cleanupStalePhotos(folderId)
      })
      .on('error', (error) => {
        console.error(`Watcher error for folder ${folderId}:`, error)
      })

    this.watchers.set(folderId, watcher)
  }

  unwatchFolder(folderId: number): void {
    const watcher = this.watchers.get(folderId)
    if (watcher) {
      watcher.close()
      this.watchers.delete(folderId)
    }
  }

  stopAll(): void {
    for (const [folderId] of this.watchers) {
      this.unwatchFolder(folderId)
    }
  }

  /** 启动时清理离线期间被删除的文件 */
  private async cleanupStalePhotos(folderId: number): Promise<void> {
    try {
      const { photoIds } = this.db.getFolderStats(folderId)
      // 逐个检查文件是否存在（用 getPhoto 拿路径）
      let cleaned = 0
      for (const photoId of photoIds) {
        const photo = this.db.getPhoto(photoId)
        if (!photo || photo.deletedAt) continue
        try {
          await access(photo.filePath)
        } catch {
          // 文件不存在，soft delete
          this.db.softDeletePhoto(photo.filePath)
          cleaned++
        }
      }
    } catch (error) {
      console.error(`Error cleaning stale photos for folder ${folderId}:`, error)
    }
  }

  private async handleAdd(folderId: number, filePath: string): Promise<void> {
    const kind = classifyMedia(filePath)
    if (kind === null) return

    if (kind === 'video') {
      await this.handleAddVideo(folderId, filePath)
      return
    }

    try {
      const stats = await stat(filePath)
      const fileName = basename(filePath)

      // 计算文件 hash
      const fileBuffer = await readFile(filePath)
      const hash = await getHasher()
      const fileHash = hash(new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength))

      const photoId = this.db.addPhoto(folderId, filePath, fileName, stats.size, stats.mtimeMs, fileHash)

      // v0.2：流水线是 thumbnail → embed（caption 不再自动生成）
      const { hasEmbedding } = this.db.hasContentForHash(fileHash)

      if (hasEmbedding) {
        // 同内容已有 embedding，仅补缩略图（如缺）
        this.db.updateEmbedStatusByHash(fileHash)
        this.db.addToQueue(photoId, 'thumbnail', 20)
        this.indexer.processNext()
      } else {
        this.db.addToQueue(photoId, 'thumbnail', 20)
        this.db.addToQueue(photoId, 'embed', 10)
        this.indexer.processNext()
      }
    } catch (error) {
      console.error(`Error handling add for ${filePath}:`, error)
    }
  }

  /**
   * 视频不入 photos 直接走 thumbnail pipeline，
   * 而是先登记到 videos 表 + queue 一个 'extract_frames' 任务；
   * indexer 抽完帧后才把每帧作为 photo 行 + 缩略图/embed/face/ocr 排队。
   */
  private async handleAddVideo(folderId: number, filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath)
      const fileName = basename(filePath)

      // 视频的 file_hash 用 (size, mtime, path) 的轻量哈希避免全文件读取——
      // 视频文件大，纯内容哈希会显著拖慢导入。等抽出帧后，每帧再用真正的
      // 内容 hash（PR11.3 indexer 里完成）。
      const lightHash = await getHasher().then((h) =>
        h(new TextEncoder().encode(`${filePath}|${stats.size}|${stats.mtimeMs}`))
      )

      const videoId = this.db.addVideo(folderId, filePath, fileName, stats.size, stats.mtimeMs, lightHash)

      // 同步抽帧太慢；用 indexer 队列异步处理。约定：task_type='extract_frames'
      // 时，photo_id 字段携带的是 videos.id 而非 photos.id（schema 不变）。
      this.db.addToQueue(videoId, 'extract_frames', 15)
      this.indexer.processNext()
    } catch (error) {
      console.error(`Error handling add for video ${filePath}:`, error)
    }
  }

  private async handleChange(filePath: string): Promise<void> {
    if (classifyMedia(filePath) === null) return

    try {
      const existing = this.db.getPhotoByPath(filePath)
      if (!existing) return

      const stats = await stat(filePath)
      if (existing.fileSize === stats.size && existing.fileMtime === stats.mtimeMs) {
        return
      }

      const fileName = basename(filePath)
      const fileBuffer = await readFile(filePath)
      const hash = await getHasher()
      const fileHash = hash(new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength))

      const photoId = this.db.addPhoto(existing.folderId, filePath, fileName, stats.size, stats.mtimeMs, fileHash)

      this.db.addToQueue(photoId, 'thumbnail', 20)
      this.db.addToQueue(photoId, 'embed', 10)
      this.indexer.processNext()
    } catch (error) {
      console.error(`Error handling change for ${filePath}:`, error)
    }
  }

  private handleRemove(filePath: string): void {
    const kind = classifyMedia(filePath)
    if (kind === null) return

    try {
      if (kind === 'video') {
        // 视频删除：标记 videos.deleted_at；它的帧 photos 仍按文件路径自己被
        // chokidar unlink 触发处理（如果对应的 frame JPEG 也被删了）。
        this.db.softDeleteVideo(filePath)
      } else {
        this.db.softDeletePhoto(filePath)
      }
    } catch (error) {
      console.error(`Error handling remove for ${filePath}:`, error)
    }
  }
}
