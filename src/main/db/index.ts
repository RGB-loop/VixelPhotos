import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { Photo, WatchedFolder, PhotoDetail } from '../../shared/types'

// 向量维度
const IMAGE_VEC_DIM = 768 // SigLIP base
const TEXT_VEC_DIM = 384 // multilingual-e5-small

// 数据库 Schema
const SCHEMA = `
-- 监控文件夹表
CREATE TABLE IF NOT EXISTS watched_folders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL UNIQUE,
  last_scan_at  DATETIME,
  recursive     BOOLEAN DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 照片主表
CREATE TABLE IF NOT EXISTS photos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id       INTEGER REFERENCES watched_folders(id),
  file_path       TEXT NOT NULL UNIQUE,
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  file_mtime      INTEGER NOT NULL,
  file_hash       TEXT,
  width           INTEGER,
  height          INTEGER,
  taken_at        DATETIME,
  lat             REAL,
  lng             REAL,
  embed_status    TEXT DEFAULT 'pending',
  caption_status  TEXT DEFAULT 'pending',
  deleted_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(embed_status, caption_status);
CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted_at);

-- 索引任务队列
CREATE TABLE IF NOT EXISTS index_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id    INTEGER REFERENCES photos(id),
  task_type   TEXT NOT NULL,
  priority    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_msg   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON index_queue(status, priority DESC);

-- Caption 表
CREATE TABLE IF NOT EXISTS captions (
  photo_id    INTEGER PRIMARY KEY REFERENCES photos(id),
  lang        TEXT DEFAULT 'en',
  text        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 图像向量表 (使用 BLOB 存储 Float32Array)
CREATE TABLE IF NOT EXISTS image_vecs (
  photo_id    INTEGER PRIMARY KEY REFERENCES photos(id),
  embedding   BLOB NOT NULL
);

-- Caption 向量表
CREATE TABLE IF NOT EXISTS caption_vecs (
  photo_id    INTEGER PRIMARY KEY REFERENCES photos(id),
  embedding   BLOB NOT NULL
);
`

export interface DatabaseInstance {
  // 文件夹操作
  addFolder: (path: string) => WatchedFolder
  removeFolder: (id: number) => void
  getFolder: (id: number) => WatchedFolder | undefined
  getFolders: () => WatchedFolder[]
  getFoldersWithStats: () => WatchedFolder[]
  updateFolderScanTime: (id: number) => void
  getFolderStats: (id: number) => { photoCount: number; photoIds: number[] }
  deletePhotosByFolder: (folderId: number) => number[]

  // 照片操作
  addPhoto: (
    folderId: number,
    filePath: string,
    fileName: string,
    fileSize: number,
    fileMtime: number
  ) => number
  getPhoto: (id: number) => Photo | undefined
  getPhotoByPath: (path: string) => Photo | undefined
  getPhotoDetail: (id: number) => PhotoDetail | undefined
  updatePhotoMeta: (
    id: number,
    data: { width?: number; height?: number; takenAt?: string; lat?: number; lng?: number }
  ) => void
  softDeletePhoto: (path: string) => void
  updatePhotoPath: (id: number, newPath: string) => void
  getPhotos: (limit: number, offset?: number) => Photo[]

  // 索引队列
  addToQueue: (photoId: number, taskType: 'embed' | 'caption', priority?: number) => void
  getNextTask: () => { id: number; photoId: number; taskType: string } | undefined
  completeTask: (taskId: number) => void
  failTask: (taskId: number, error: string) => void
  getQueueStats: () => { pending: number; processing: number; done: number }

  // 照片统计（用于进度展示）
  getPhotoStats: () => { total: number; indexed: number; captioned: number }

  // 向量操作
  saveImageVec: (photoId: number, embedding: Float32Array) => void
  saveCaptionVec: (photoId: number, embedding: Float32Array) => void
  saveCaption: (photoId: number, text: string) => void
  getCaption: (photoId: number) => string | undefined

  // 向量搜索
  searchByImageVec: (
    queryVec: Float32Array,
    limit: number
  ) => Array<{ photoId: number; distance: number }>
  searchByCaptionVec: (
    queryVec: Float32Array,
    limit: number
  ) => Array<{ photoId: number; distance: number }>

  // 关闭
  close: () => void
}

// 计算余弦相似度 (归一化向量的点积)
function cosineSimilarity(vec1: Float32Array, vec2: Float32Array): number {
  if (vec1.length !== vec2.length) return 0

  let dotProduct = 0
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i]
  }
  return dotProduct
}

// 将 Buffer 转换为 Float32Array
function bufferToVec(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

// 将 Float32Array 转换为 Buffer
function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function initDatabase(dbPath: string): DatabaseInstance {
  // 确保目录存在
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const db = new Database(dbPath)

  // 启用 WAL 模式
  db.pragma('journal_mode = WAL')

  // 执行 schema
  db.exec(SCHEMA)

  // 预编译常用语句
  const stmts = {
    addFolder: db.prepare(`
      INSERT INTO watched_folders (path) VALUES (?)
      RETURNING *
    `),
    removeFolder: db.prepare(`DELETE FROM watched_folders WHERE id = ?`),
    getFolder: db.prepare(`SELECT * FROM watched_folders WHERE id = ?`),
    getFolders: db.prepare(`SELECT * FROM watched_folders ORDER BY created_at DESC`),
    getFoldersWithStats: db.prepare(`
      SELECT wf.*, COUNT(p.id) as photoCount
      FROM watched_folders wf
      LEFT JOIN photos p ON wf.id = p.folder_id AND p.deleted_at IS NULL
      GROUP BY wf.id
      ORDER BY wf.created_at DESC
    `),
    updateFolderScanTime: db.prepare(`
      UPDATE watched_folders SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?
    `),
    getFolderPhotoCount: db.prepare(`
      SELECT COUNT(*) as count FROM photos WHERE folder_id = ? AND deleted_at IS NULL
    `),
    getFolderPhotoIds: db.prepare(`
      SELECT id FROM photos WHERE folder_id = ?
    `),
    deletePhotosByFolderId: db.prepare(`DELETE FROM photos WHERE folder_id = ?`),
    deleteCaptionsByPhotoIds: db.prepare(`DELETE FROM captions WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`),
    deleteImageVecsByPhotoIds: db.prepare(`DELETE FROM image_vecs WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`),
    deleteCaptionVecsByPhotoIds: db.prepare(`DELETE FROM caption_vecs WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`),
    deleteQueueByPhotoIds: db.prepare(`DELETE FROM index_queue WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`),

    addPhoto: db.prepare(`
      INSERT INTO photos (folder_id, file_path, file_name, file_size, file_mtime)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `),
    getPhoto: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, width, height,
             taken_at as takenAt, lat, lng, embed_status as embedStatus,
             caption_status as captionStatus, deleted_at as deletedAt,
             created_at as createdAt, updated_at as updatedAt
      FROM photos WHERE id = ?
    `),
    getPhotoByPath: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, width, height,
             taken_at as takenAt, lat, lng, embed_status as embedStatus,
             caption_status as captionStatus, deleted_at as deletedAt,
             created_at as createdAt, updated_at as updatedAt
      FROM photos WHERE file_path = ?
    `),
    getPhotos: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, width, height,
             taken_at as takenAt, lat, lng, embed_status as embedStatus,
             caption_status as captionStatus, deleted_at as deletedAt,
             created_at as createdAt, updated_at as updatedAt
      FROM photos
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `),
    updatePhotoMeta: db.prepare(`
      UPDATE photos SET width = ?, height = ?, taken_at = ?, lat = ?, lng = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `),
    softDeletePhoto: db.prepare(`
      UPDATE photos SET deleted_at = CURRENT_TIMESTAMP WHERE file_path = ?
    `),
    updatePhotoPath: db.prepare(`
      UPDATE photos SET file_path = ?, file_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `),

    addToQueue: db.prepare(`
      INSERT INTO index_queue (photo_id, task_type, priority) VALUES (?, ?, ?)
    `),
    getNextTask: db.prepare(`
      SELECT id, photo_id as photoId, task_type as taskType FROM index_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `),
    markTaskProcessing: db.prepare(`UPDATE index_queue SET status = 'processing' WHERE id = ?`),
    completeTask: db.prepare(`UPDATE index_queue SET status = 'done' WHERE id = ?`),
    failTask: db.prepare(`
      UPDATE index_queue SET status = 'error', error_msg = ?, retry_count = retry_count + 1 WHERE id = ?
    `),
    getQueueStats: db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) as done
      FROM index_queue
    `),

    // 照片统计（基于照片数，不是任务数）
    getPhotoStats: db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN embed_status = 'done' THEN 1 ELSE 0 END) as indexed,
        SUM(CASE WHEN caption_status = 'done' THEN 1 ELSE 0 END) as captioned
      FROM photos
      WHERE deleted_at IS NULL
    `),

    // 向量操作
    saveImageVec: db.prepare(`
      INSERT INTO image_vecs (photo_id, embedding) VALUES (?, ?)
      ON CONFLICT(photo_id) DO UPDATE SET embedding = excluded.embedding
    `),
    updateEmbedStatus: db.prepare(`UPDATE photos SET embed_status = 'done' WHERE id = ?`),

    saveCaption: db.prepare(`
      INSERT OR REPLACE INTO captions (photo_id, text) VALUES (?, ?)
    `),
    getCaption: db.prepare(`SELECT text FROM captions WHERE photo_id = ?`),
    saveCaptionVec: db.prepare(`
      INSERT INTO caption_vecs (photo_id, embedding) VALUES (?, ?)
      ON CONFLICT(photo_id) DO UPDATE SET embedding = excluded.embedding
    `),
    updateCaptionStatus: db.prepare(`UPDATE photos SET caption_status = 'done' WHERE id = ?`),

    getPhotoWithCaption: db.prepare(`
      SELECT p.id, p.folder_id as folderId, p.file_path as filePath, p.file_name as fileName,
             p.file_size as fileSize, p.file_mtime as fileMtime, p.width, p.height,
             p.taken_at as takenAt, p.lat, p.lng, p.embed_status as embedStatus,
             p.caption_status as captionStatus, p.deleted_at as deletedAt,
             p.created_at as createdAt, p.updated_at as updatedAt, c.text as caption
      FROM photos p
      LEFT JOIN captions c ON p.id = c.photo_id
      WHERE p.id = ?
    `),

    // 获取所有图像向量
    getAllImageVecs: db.prepare(`
      SELECT iv.photo_id, iv.embedding
      FROM image_vecs iv
      JOIN photos p ON iv.photo_id = p.id
      WHERE p.deleted_at IS NULL AND p.embed_status = 'done'
    `),

    // 获取所有 Caption 向量
    getAllCaptionVecs: db.prepare(`
      SELECT cv.photo_id, cv.embedding
      FROM caption_vecs cv
      JOIN photos p ON cv.photo_id = p.id
      WHERE p.deleted_at IS NULL AND p.caption_status = 'done'
    `),
  }

  return {
    addFolder: (path: string): WatchedFolder => {
      return stmts.addFolder.get(path) as WatchedFolder
    },

    removeFolder: (id: number): void => {
      stmts.removeFolder.run(id)
    },

    getFolder: (id: number): WatchedFolder | undefined => {
      return stmts.getFolder.get(id) as WatchedFolder | undefined
    },

    getFolders: (): WatchedFolder[] => {
      return stmts.getFolders.all() as WatchedFolder[]
    },

    getFoldersWithStats: (): WatchedFolder[] => {
      return stmts.getFoldersWithStats.all() as WatchedFolder[]
    },

    updateFolderScanTime: (id: number): void => {
      stmts.updateFolderScanTime.run(id)
    },

    getFolderStats: (id: number): { photoCount: number; photoIds: number[] } => {
      const countResult = stmts.getFolderPhotoCount.get(id) as { count: number }
      const idsResult = stmts.getFolderPhotoIds.all(id) as Array<{ id: number }>
      return {
        photoCount: countResult.count,
        photoIds: idsResult.map((r) => r.id),
      }
    },

    deletePhotosByFolder: (folderId: number): number[] => {
      // 获取所有要删除的照片 ID（用于后续清理缩略图）
      const idsResult = stmts.getFolderPhotoIds.all(folderId) as Array<{ id: number }>
      const photoIds = idsResult.map((r) => r.id)

      // 级联删除所有相关数据
      stmts.deleteQueueByPhotoIds.run(folderId)
      stmts.deleteCaptionsByPhotoIds.run(folderId)
      stmts.deleteImageVecsByPhotoIds.run(folderId)
      stmts.deleteCaptionVecsByPhotoIds.run(folderId)
      stmts.deletePhotosByFolderId.run(folderId)

      return photoIds
    },

    addPhoto: (
      folderId: number,
      filePath: string,
      fileName: string,
      fileSize: number,
      fileMtime: number
    ): number => {
      const result = stmts.addPhoto.get(folderId, filePath, fileName, fileSize, fileMtime) as {
        id: number
      }
      return result.id
    },

    getPhoto: (id: number): Photo | undefined => {
      return stmts.getPhoto.get(id) as Photo | undefined
    },

    getPhotoByPath: (path: string): Photo | undefined => {
      return stmts.getPhotoByPath.get(path) as Photo | undefined
    },

    getPhotoDetail: (id: number): PhotoDetail | undefined => {
      return stmts.getPhotoWithCaption.get(id) as PhotoDetail | undefined
    },

    getPhotos: (limit: number, offset = 0): Photo[] => {
      return stmts.getPhotos.all(limit, offset) as Photo[]
    },

    updatePhotoMeta: (id, data): void => {
      stmts.updatePhotoMeta.run(data.width, data.height, data.takenAt, data.lat, data.lng, id)
    },

    softDeletePhoto: (path: string): void => {
      stmts.softDeletePhoto.run(path)
    },

    updatePhotoPath: (id: number, newPath: string): void => {
      const fileName = newPath.split('/').pop() || ''
      stmts.updatePhotoPath.run(newPath, fileName, id)
    },

    addToQueue: (photoId: number, taskType: 'embed' | 'caption', priority = 0): void => {
      stmts.addToQueue.run(photoId, taskType, priority)
    },

    getNextTask: () => {
      const task = stmts.getNextTask.get() as
        | { id: number; photoId: number; taskType: string }
        | undefined
      if (task) {
        stmts.markTaskProcessing.run(task.id)
      }
      return task
    },

    completeTask: (taskId: number): void => {
      stmts.completeTask.run(taskId)
    },

    failTask: (taskId: number, error: string): void => {
      stmts.failTask.run(error, taskId)
    },

    getQueueStats: () => {
      const result = stmts.getQueueStats.get() as {
        pending: number
        processing: number
        done: number
      }
      return {
        pending: result.pending || 0,
        processing: result.processing || 0,
        done: result.done || 0,
      }
    },

    getPhotoStats: () => {
      const result = stmts.getPhotoStats.get() as {
        total: number
        indexed: number
        captioned: number
      }
      return {
        total: result.total || 0,
        indexed: result.indexed || 0,
        captioned: result.captioned || 0,
      }
    },

    saveImageVec: (photoId: number, embedding: Float32Array): void => {
      const buffer = vecToBuffer(embedding)
      stmts.saveImageVec.run(photoId, buffer)
      stmts.updateEmbedStatus.run(photoId)
    },

    saveCaption: (photoId: number, text: string): void => {
      stmts.saveCaption.run(photoId, text)
    },

    getCaption: (photoId: number): string | undefined => {
      const result = stmts.getCaption.get(photoId) as { text: string } | undefined
      return result?.text
    },

    saveCaptionVec: (photoId: number, embedding: Float32Array): void => {
      const buffer = vecToBuffer(embedding)
      stmts.saveCaptionVec.run(photoId, buffer)
      stmts.updateCaptionStatus.run(photoId)
    },

    // 暴力向量搜索（MVP 版本，后续可优化为 ANN）
    searchByImageVec: (
      queryVec: Float32Array,
      limit: number
    ): Array<{ photoId: number; distance: number }> => {
      try {
        const allVecs = stmts.getAllImageVecs.all() as Array<{
          photo_id: number
          embedding: Buffer
        }>

        // 计算相似度并排序
        const results = allVecs
          .map((row) => {
            const embedding = bufferToVec(row.embedding)
            const similarity = cosineSimilarity(queryVec, embedding)
            return {
              photoId: row.photo_id,
              distance: 1 - similarity, // 转换为距离
            }
          })
          .sort((a, b) => a.distance - b.distance)
          .slice(0, limit)

        return results
      } catch (error) {
        console.error('Image vector search error:', error)
        return []
      }
    },

    searchByCaptionVec: (
      queryVec: Float32Array,
      limit: number
    ): Array<{ photoId: number; distance: number }> => {
      try {
        const allVecs = stmts.getAllCaptionVecs.all() as Array<{
          photo_id: number
          embedding: Buffer
        }>

        // 计算相似度并排序
        const results = allVecs
          .map((row) => {
            const embedding = bufferToVec(row.embedding)
            const similarity = cosineSimilarity(queryVec, embedding)
            return {
              photoId: row.photo_id,
              distance: 1 - similarity,
            }
          })
          .sort((a, b) => a.distance - b.distance)
          .slice(0, limit)

        return results
      } catch (error) {
        console.error('Caption vector search error:', error)
        return []
      }
    },

    close: (): void => {
      db.close()
    },
  }
}
