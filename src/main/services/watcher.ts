import chokidar from 'chokidar'
import { basename, extname } from 'path'
import { stat } from 'fs/promises'
import type { DatabaseInstance } from '../db'
import type { Indexer } from './indexer'

// 支持的图片格式
const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.heic',
  '.webp',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  // RAW 格式
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.raf',
  '.orf',
  '.rw2',
])

function isSupportedImage(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(ext)
}

export class FileWatcher {
  private watchers: Map<number, chokidar.FSWatcher> = new Map()
  private db: DatabaseInstance
  private indexer: Indexer

  constructor(db: DatabaseInstance, indexer: Indexer) {
    this.db = db
    this.indexer = indexer
  }

  /**
   * 开始监听一个文件夹
   */
  watchFolder(folderId: number, folderPath: string): void {
    if (this.watchers.has(folderId)) {
      console.log(`Folder ${folderId} already being watched`)
      return
    }

    console.log(`Starting to watch folder: ${folderPath}`)

    const watcher = chokidar.watch(folderPath, {
      ignored: [
        /(^|[\/\\])\../, // 忽略隐藏文件
        /node_modules/,
        /\.git/,
      ],
      persistent: true,
      ignoreInitial: false, // 首次扫描时触发 add 事件
      awaitWriteFinish: {
        stabilityThreshold: 2000, // 等待文件写入完成
        pollInterval: 100,
      },
      depth: 99, // 递归深度
    })

    watcher
      .on('add', (filePath) => this.handleAdd(folderId, filePath))
      .on('change', (filePath) => this.handleChange(filePath))
      .on('unlink', (filePath) => this.handleRemove(filePath))
      .on('ready', () => {
        console.log(`Initial scan complete for folder: ${folderPath}`)
        this.db.updateFolderScanTime(folderId)
      })
      .on('error', (error) => {
        console.error(`Watcher error for folder ${folderId}:`, error)
      })

    this.watchers.set(folderId, watcher)
  }

  /**
   * 停止监听一个文件夹
   */
  unwatchFolder(folderId: number): void {
    const watcher = this.watchers.get(folderId)
    if (watcher) {
      watcher.close()
      this.watchers.delete(folderId)
      console.log(`Stopped watching folder: ${folderId}`)
    }
  }

  /**
   * 停止所有监听
   */
  stopAll(): void {
    for (const [folderId] of this.watchers) {
      this.unwatchFolder(folderId)
    }
  }

  /**
   * 处理新增文件
   */
  private async handleAdd(folderId: number, filePath: string): Promise<void> {
    if (!isSupportedImage(filePath)) return

    try {
      const stats = await stat(filePath)
      const fileName = basename(filePath)

      const photoId = this.db.addPhoto(folderId, filePath, fileName, stats.size, stats.mtimeMs)

      // 添加到索引队列（高优先级）
      this.db.addToQueue(photoId, 'embed', 10)

      this.indexer.processNext()
    } catch (error) {
      console.error(`Error handling add for ${filePath}:`, error)
    }
  }

  /**
   * 处理文件修改
   */
  private async handleChange(filePath: string): Promise<void> {
    if (!isSupportedImage(filePath)) return

    try {
      const existing = this.db.getPhotoByPath(filePath)
      if (!existing) return

      const stats = await stat(filePath)

      // 检查是否真的有变化
      if (existing.fileSize === stats.size && existing.fileMtime === stats.mtimeMs) {
        return
      }

      // 重新索引
      const fileName = basename(filePath)
      const photoId = this.db.addPhoto(existing.folderId, filePath, fileName, stats.size, stats.mtimeMs)

      this.db.addToQueue(photoId, 'embed', 10)
      this.indexer.processNext()
    } catch (error) {
      console.error(`Error handling change for ${filePath}:`, error)
    }
  }

  /**
   * 处理文件删除
   */
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
