import chokidar, { type FSWatcher } from 'chokidar'
import { basename, extname } from 'path'
import { stat, readFile, access, rm, unlink, open } from 'fs/promises'
import { existsSync } from 'fs'
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

const VIDEO_HASH_SAMPLE_BYTES = 64 * 1024

/**
 * 计算视频文件的"轻量内容哈希"：size + mtime + 头 N 字节 + 尾 N 字节。
 * 对个人相册体量足够区分；不读全文件（多 GB 视频几秒钟卡住 watcher 不可接受）。
 *
 * 路径**不参与**哈希 —— 这是有意为之：搬动视频后内容不变，dedup 应该
 * 仍然把它识别为同一个素材。
 */
async function computeVideoLightHash(
  filePath: string,
  size: number,
  mtimeMs: number,
  hasher: (input: Uint8Array) => string
): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const headLen = Math.min(VIDEO_HASH_SAMPLE_BYTES, size)
    const head = Buffer.alloc(headLen)
    if (headLen > 0) await handle.read(head, 0, headLen, 0)

    let tail = Buffer.alloc(0)
    // 文件足够大才采尾部，否则头部已经覆盖整个文件
    if (size > VIDEO_HASH_SAMPLE_BYTES * 2) {
      tail = Buffer.alloc(VIDEO_HASH_SAMPLE_BYTES)
      await handle.read(tail, 0, VIDEO_HASH_SAMPLE_BYTES, size - VIDEO_HASH_SAMPLE_BYTES)
    }

    const meta = new TextEncoder().encode(`v1|${size}|${mtimeMs}|`)
    const combined = Buffer.concat([Buffer.from(meta), head, tail])
    return hasher(new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength))
  } finally {
    await handle.close()
  }
}

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

      // 流水线：thumbnail → embed
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
   * indexer 切 32s 片段编码进 video_segments，并把首帧落成代表 photo。
   */
  private async handleAddVideo(folderId: number, filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath)
      const fileName = basename(filePath)

      // 视频的 file_hash 用"size + mtime + 头尾 64 KB 内容"做轻量哈希：
      //   - 不读全文件（GB 级视频会让 watcher 卡几秒）
      //   - 路径不参与（搬动视频不破坏 dedup）
      //   - 头尾采样能可靠区分 mtime 巧合相同的不同文件
      //     (rsync --times / cp -p / 时钟回拨等场景下 size+mtime 单独是不够的)
      const hasher = await getHasher()
      const lightHash = await computeVideoLightHash(filePath, stats.size, stats.mtimeMs, hasher)

      const videoId = this.db.addVideo(folderId, filePath, fileName, stats.size, stats.mtimeMs, lightHash)

      // 同步抽帧太慢；用 indexer 队列异步处理。约定：task_type='extract_frames'
      // 时，photo_id 字段携带的是 videos.id 而非 photos.id（schema 不变）。
      // 优先级 6：排在图片 embed(10) / face(8) 之后 —— 视频按片段编码，一个长视频
      // 就要几分钟，放前面会让整库照片在视频跑完前都搜不到
      this.db.addToQueue(videoId, 'extract_frames', 6)
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

  private async handleRemove(filePath: string): Promise<void> {
    const kind = classifyMedia(filePath)
    if (kind === null) return

    try {
      if (kind === 'video') {
        await this.removeVideo(filePath)
      } else {
        this.db.softDeletePhoto(filePath)
      }
    } catch (error) {
      console.error(`Error handling remove for ${filePath}:`, error)
    }
  }

  /**
   * 视频删除的完整级联：cascadeRemoveVideo 处理 DB（soft-delete video、
   * frame photos、孤立 hash 的内容），这里负责清理磁盘上的 JPG 帧目录
   * 与共享的缩略图（如果该 hash 已彻底无活体引用）。
   *
   * Frame JPG 落在 <userData>/video_frames/<videoHash>/，不在用户监控目录里，
   * 所以 chokidar 不会触发它们自己的 unlink — 必须显式删。
   */
  private async removeVideo(filePath: string): Promise<void> {
    const result = this.db.cascadeRemoveVideo(filePath)
    if (!result) return // 视频不在库中

    const { fileHash, orphanedFrameHashes } = result

    // 帧 JPG 目录：通常以 video hash 命名，整目录 rm
    if (fileHash) {
      const framesDir = this.indexer.getVideoFramesDir(fileHash)
      if (existsSync(framesDir)) {
        try {
          await rm(framesDir, { recursive: true, force: true })
        } catch (err) {
          console.warn(`Failed to remove video frames dir ${framesDir}:`, err)
        }
      }
    }

    // 共享缩略图：孤立 frame hash 的 .webp 文件
    for (const hash of orphanedFrameHashes) {
      const thumb = this.indexer.getThumbnailPath(hash)
      try {
        if (existsSync(thumb)) await unlink(thumb)
      } catch (err) {
        console.warn(`Failed to remove thumbnail ${thumb}:`, err)
      }
    }
  }
}
