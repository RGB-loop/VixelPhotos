import chokidar, { type FSWatcher } from 'chokidar'
import { basename, extname } from 'path'
import { stat, readFile, access } from 'fs/promises'
import xxhash from 'xxhash-wasm'
import type { DatabaseInstance } from '../db'
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
const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.bmp', '.tiff', '.tif',
  '.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2',
])

function isSupportedImage(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(ext)
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
      console.log(`Folder ${folderId} already being watched`)
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
        console.log(`Initial scan complete for folder: ${folderPath}`)
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
      console.log(`Stopped watching folder: ${folderId}`)
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
      if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} stale photos in folder ${folderId}`)
      }
    } catch (error) {
      console.error(`Error cleaning stale photos for folder ${folderId}:`, error)
    }
  }

  private async handleAdd(folderId: number, filePath: string): Promise<void> {
    if (!isSupportedImage(filePath)) return

    try {
      const stats = await stat(filePath)
      const fileName = basename(filePath)

      // 计算文件 hash
      const fileBuffer = await readFile(filePath)
      const hash = await getHasher()
      const fileHash = hash(new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength))

      const photoId = this.db.addPhoto(folderId, filePath, fileName, stats.size, stats.mtimeMs, fileHash)

      // 检查该 hash 是否已有内容（缩略图/embedding/caption）
      const { hasEmbedding, hasCaption } = this.db.hasContentForHash(fileHash)

      if (hasEmbedding && hasCaption) {
        // 重复照片：资源已存在，直接标记完成
        console.log(`Duplicate detected (hash=${fileHash}): ${filePath}, skipping processing`)
        this.db.markDuplicateProcessed(photoId)
        this.indexer.emitProgressPublic()
      } else if (hasEmbedding) {
        // 有 embedding 但无 caption（可能 caption 还在处理中）
        this.db.addToQueue(photoId, 'thumbnail', 20)
        this.db.addToQueue(photoId, 'caption', 5)
        this.indexer.processNext()
      } else {
        // 全新内容：需要完整处理
        this.db.addToQueue(photoId, 'thumbnail', 20)
        this.db.addToQueue(photoId, 'embed', 10)
        this.indexer.processNext()
      }
    } catch (error) {
      console.error(`Error handling add for ${filePath}:`, error)
    }
  }

  private async handleChange(filePath: string): Promise<void> {
    if (!isSupportedImage(filePath)) return

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
    if (!isSupportedImage(filePath)) return

    try {
      this.db.softDeletePhoto(filePath)
      console.log(`Soft deleted: ${filePath}`)
    } catch (error) {
      console.error(`Error handling remove for ${filePath}:`, error)
    }
  }
}
