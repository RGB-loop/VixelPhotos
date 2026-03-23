import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { Photo, WatchedFolder, PhotoDetail, PhotoLocation } from '../../shared/types'

// 向量维度 - Qwen3-VL-Embedding
const EMBEDDING_DIM = 2048

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

-- 照片主表（每个文件路径一条记录）
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
CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(file_hash);

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

-- Caption 表（按 file_hash 去重共享）
CREATE TABLE IF NOT EXISTS captions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  lang        TEXT DEFAULT 'en',
  text        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 图像向量表（按 file_hash 去重共享）
CREATE TABLE IF NOT EXISTS image_vecs (
  file_hash   TEXT PRIMARY KEY,
  embedding   BLOB NOT NULL
);

-- Caption 全文搜索表 (FTS5, standalone — 通过触发器同步)
CREATE VIRTUAL TABLE IF NOT EXISTS captions_fts USING fts5(
  text,
  tokenize='unicode61'
);

-- FTS5 同步触发器（standalone FTS5 用普通 INSERT/DELETE）
CREATE TRIGGER IF NOT EXISTS captions_ai AFTER INSERT ON captions BEGIN
  INSERT INTO captions_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS captions_ad AFTER DELETE ON captions BEGIN
  DELETE FROM captions_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS captions_au AFTER UPDATE ON captions BEGIN
  DELETE FROM captions_fts WHERE rowid = old.id;
  INSERT INTO captions_fts(rowid, text) VALUES (new.id, new.text);
END;
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
  deletePhotosByFolder: (folderId: number) => string[] // 返回孤立的 file_hash 列表

  // 照片操作
  addPhoto: (
    folderId: number,
    filePath: string,
    fileName: string,
    fileSize: number,
    fileMtime: number,
    fileHash: string
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
  getRepresentativePhotos: (limit: number, offset?: number) => Photo[]
  getPhotoLocations: (fileHash: string) => PhotoLocation[]
  markDuplicateProcessed: (photoId: number) => void

  // 索引队列
  addToQueue: (photoId: number, taskType: string, priority?: number) => void
  getNextTask: () => { id: number; photoId: number; taskType: string } | undefined
  peekNextTask: () => { id: number; photoId: number; taskType: string } | undefined
  completeTask: (taskId: number) => void
  resetTask: (taskId: number) => void
  failTask: (taskId: number, error: string) => void
  recoverStuckTasks: () => number
  requeueMissingEmbeddings: () => number
  getQueueStats: () => { pending: number; processing: number; done: number }

  // 照片统计
  getPhotoStats: () => { total: number; uniqueTotal: number; thumbnailed: number; indexed: number; captioned: number }

  // 内容操作（按 file_hash 共享）
  hasContentForHash: (fileHash: string) => { hasEmbedding: boolean; hasCaption: boolean }
  saveImageVec: (fileHash: string, embedding: Float32Array) => void
  updateEmbedStatusByHash: (fileHash: string) => void
  saveCaption: (fileHash: string, text: string) => void
  updateCaptionStatusByHash: (fileHash: string) => void
  getCaption: (fileHash: string) => string | undefined
  deleteContentByHash: (fileHash: string) => void

  // 搜索
  searchByVec: (
    queryVec: Float32Array,
    limit: number
  ) => Array<{ fileHash: string; distance: number }>
  searchByText: (
    query: string,
    limit: number
  ) => Array<{ fileHash: string; score: number }>
  searchByFileName: (
    query: string,
    limit: number
  ) => Array<{ fileHash: string }>
  getRepresentativeByHash: (fileHash: string) => Photo | undefined
  getRepresentativePhotosFiltered: (
    limit: number,
    offset: number,
    dateFrom?: string,
    dateTo?: string
  ) => Photo[]
  findSimilar: (
    fileHash: string,
    limit: number
  ) => Array<{ fileHash: string; distance: number }>

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

function bufferToVec(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function initDatabase(dbPath: string): DatabaseInstance {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  // 检测旧 schema 并迁移
  migrateIfNeeded(db)

  db.exec(SCHEMA)

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
    // 查找文件夹内照片的 hash 中，没有其他存活副本的（孤立 hash）
    getOrphanedHashes: db.prepare(`
      SELECT DISTINCT p1.file_hash
      FROM photos p1
      WHERE p1.folder_id = ? AND p1.file_hash IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM photos p2
          WHERE p2.file_hash = p1.file_hash
            AND p2.folder_id != ?
            AND p2.deleted_at IS NULL
        )
    `),
    deletePhotosByFolderId: db.prepare(`DELETE FROM photos WHERE folder_id = ?`),
    deleteQueueByPhotoIds: db.prepare(`DELETE FROM index_queue WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`),

    addPhoto: db.prepare(`
      INSERT INTO photos (folder_id, file_path, file_name, file_size, file_mtime, file_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        file_hash = excluded.file_hash,
        deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `),

    // 照片字段映射（复用）
    getPhoto: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, caption_status as captionStatus,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos WHERE id = ?
    `),
    getPhotoByPath: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, caption_status as captionStatus,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos WHERE file_path = ?
    `),
    getPhotos: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, caption_status as captionStatus,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `),
    // 代表照片：每组 hash 取最早入库的（MIN(id)），带副本计数
    getRepresentativePhotos: db.prepare(`
      SELECT p.id, p.folder_id as folderId, p.file_path as filePath, p.file_name as fileName,
             p.file_size as fileSize, p.file_mtime as fileMtime, p.file_hash as fileHash,
             p.width, p.height, p.taken_at as takenAt, p.lat, p.lng,
             p.embed_status as embedStatus, p.caption_status as captionStatus,
             p.deleted_at as deletedAt, p.created_at as createdAt, p.updated_at as updatedAt,
             (SELECT COUNT(*) FROM photos p2
              WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL) as duplicateCount
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.id = (
          SELECT MIN(p3.id) FROM photos p3
          WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL
        )
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `),
    getRepresentativeByHash: db.prepare(`
      SELECT p.id, p.folder_id as folderId, p.file_path as filePath, p.file_name as fileName,
             p.file_size as fileSize, p.file_mtime as fileMtime, p.file_hash as fileHash,
             p.width, p.height, p.taken_at as takenAt, p.lat, p.lng,
             p.embed_status as embedStatus, p.caption_status as captionStatus,
             p.deleted_at as deletedAt, p.created_at as createdAt, p.updated_at as updatedAt,
             (SELECT COUNT(*) FROM photos p2
              WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL) as duplicateCount
      FROM photos p
      WHERE p.file_hash = ? AND p.deleted_at IS NULL
      ORDER BY p.id ASC
      LIMIT 1
    `),
    getPhotoLocations: db.prepare(`
      SELECT p.file_path as filePath, p.folder_id as folderId,
             f.path as folderPath
      FROM photos p
      JOIN watched_folders f ON p.folder_id = f.id
      WHERE p.file_hash = ? AND p.deleted_at IS NULL
      ORDER BY p.id ASC
    `),
    getPhotoWithCaption: db.prepare(`
      SELECT p.id, p.folder_id as folderId, p.file_path as filePath, p.file_name as fileName,
             p.file_size as fileSize, p.file_mtime as fileMtime, p.file_hash as fileHash,
             p.width, p.height, p.taken_at as takenAt, p.lat, p.lng,
             p.embed_status as embedStatus, p.caption_status as captionStatus,
             p.deleted_at as deletedAt, p.created_at as createdAt, p.updated_at as updatedAt,
             c.text as caption
      FROM photos p
      LEFT JOIN captions c ON p.file_hash = c.file_hash
      WHERE p.id = ?
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
    markDuplicateProcessed: db.prepare(`
      UPDATE photos SET embed_status = 'done', caption_status = 'done', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
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
    peekNextTask: db.prepare(`
      SELECT id, photo_id as photoId, task_type as taskType FROM index_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `),
    markTaskProcessing: db.prepare(`UPDATE index_queue SET status = 'processing' WHERE id = ?`),
    completeTask: db.prepare(`UPDATE index_queue SET status = 'done' WHERE id = ?`),
    resetTask: db.prepare(`UPDATE index_queue SET status = 'pending' WHERE id = ?`),
    failTask: db.prepare(`
      UPDATE index_queue SET status = 'error', error_msg = ?, retry_count = retry_count + 1 WHERE id = ?
    `),
    recoverStuckTasks: db.prepare(`
      UPDATE index_queue SET status = 'pending' WHERE status = 'processing'
    `),
    getPhotosWithoutEmbedding: db.prepare(`
      SELECT p.id, p.file_hash FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.file_hash IS NOT NULL
        AND p.file_hash NOT IN (SELECT file_hash FROM image_vecs)
        AND p.id NOT IN (SELECT photo_id FROM index_queue WHERE task_type = 'embed' AND status IN ('pending', 'processing'))
    `),
    getQueueStats: db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) as done
      FROM index_queue
    `),
    getPhotoStats: db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(DISTINCT file_hash) as uniqueTotal,
        SUM(CASE WHEN width IS NOT NULL THEN 1 ELSE 0 END) as thumbnailed,
        SUM(CASE WHEN embed_status = 'done' THEN 1 ELSE 0 END) as indexed,
        SUM(CASE WHEN caption_status = 'done' THEN 1 ELSE 0 END) as captioned
      FROM photos
      WHERE deleted_at IS NULL
    `),

    // 内容操作（按 file_hash）
    hasEmbeddingForHash: db.prepare(`SELECT 1 FROM image_vecs WHERE file_hash = ?`),
    hasCaptionForHash: db.prepare(`SELECT 1 FROM captions WHERE file_hash = ?`),
    saveImageVec: db.prepare(`
      INSERT INTO image_vecs (file_hash, embedding) VALUES (?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET embedding = excluded.embedding
    `),
    updateEmbedStatusByHash: db.prepare(`
      UPDATE photos SET embed_status = 'done' WHERE file_hash = ? AND deleted_at IS NULL
    `),
    saveCaption: db.prepare(`
      INSERT INTO captions (file_hash, text) VALUES (?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET text = excluded.text
    `),
    updateCaptionStatusByHash: db.prepare(`
      UPDATE photos SET caption_status = 'done' WHERE file_hash = ? AND deleted_at IS NULL
    `),
    getCaption: db.prepare(`SELECT text FROM captions WHERE file_hash = ?`),
    deleteImageVecByHash: db.prepare(`DELETE FROM image_vecs WHERE file_hash = ?`),
    deleteCaptionByHash: db.prepare(`DELETE FROM captions WHERE file_hash = ?`),

    // 搜索
    searchByText: db.prepare(`
      SELECT c.file_hash, bm25(captions_fts) as score
      FROM captions_fts
      JOIN captions c ON captions_fts.rowid = c.id
      WHERE captions_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `),
    getAllImageVecs: db.prepare(`
      SELECT file_hash, embedding FROM image_vecs
    `),
    // 文件名搜索（LIKE 模糊匹配，按 hash 去重）
    searchByFileName: db.prepare(`
      SELECT DISTINCT file_hash FROM photos
      WHERE deleted_at IS NULL AND (file_name LIKE ? OR file_path LIKE ?)
      LIMIT ?
    `),
    // 带时间过滤的代表照片查询
    getRepresentativePhotosFiltered: db.prepare(`
      SELECT p.id, p.folder_id as folderId, p.file_path as filePath, p.file_name as fileName,
             p.file_size as fileSize, p.file_mtime as fileMtime, p.file_hash as fileHash,
             p.width, p.height, p.taken_at as takenAt, p.lat, p.lng,
             p.embed_status as embedStatus, p.caption_status as captionStatus,
             p.deleted_at as deletedAt, p.created_at as createdAt, p.updated_at as updatedAt,
             (SELECT COUNT(*) FROM photos p2
              WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL) as duplicateCount
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.id = (
          SELECT MIN(p3.id) FROM photos p3
          WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL
        )
        AND (? IS NULL OR p.taken_at >= ?)
        AND (? IS NULL OR p.taken_at <= ?)
      ORDER BY p.taken_at DESC, p.created_at DESC
      LIMIT ? OFFSET ?
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
    deletePhotosByFolder: (folderId: number): string[] => {
      // 找出孤立的 hash（该文件夹内的，且没有其他文件夹有存活副本）
      const orphanedHashes = (stmts.getOrphanedHashes.all(folderId, folderId) as Array<{ file_hash: string }>)
        .map((r) => r.file_hash)

      // 删除队列和照片
      stmts.deleteQueueByPhotoIds.run(folderId)
      stmts.deletePhotosByFolderId.run(folderId)

      // 删除孤立 hash 的内容
      for (const hash of orphanedHashes) {
        stmts.deleteImageVecByHash.run(hash)
        stmts.deleteCaptionByHash.run(hash)
      }

      return orphanedHashes // 调用方用于清理缩略图文件
    },

    addPhoto: (folderId, filePath, fileName, fileSize, fileMtime, fileHash): number => {
      const result = stmts.addPhoto.get(folderId, filePath, fileName, fileSize, fileMtime, fileHash) as { id: number }
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
    getPhotos: (limit: number, offset = 0): Photo[] => {
      return stmts.getPhotos.all(limit, offset) as Photo[]
    },
    getRepresentativePhotos: (limit: number, offset = 0): Photo[] => {
      return stmts.getRepresentativePhotos.all(limit, offset) as Photo[]
    },
    getPhotoLocations: (fileHash: string): PhotoLocation[] => {
      const rows = stmts.getPhotoLocations.all(fileHash) as Array<{
        filePath: string; folderId: number; folderPath: string
      }>
      return rows.map((r) => ({
        filePath: r.filePath,
        folderPath: r.folderPath,
        folderName: r.folderPath.split('/').pop() || r.folderPath,
        folderId: r.folderId,
      }))
    },
    markDuplicateProcessed: (photoId: number): void => {
      stmts.markDuplicateProcessed.run(photoId)
    },
    getRepresentativeByHash: (fileHash: string): Photo | undefined => {
      return stmts.getRepresentativeByHash.get(fileHash) as Photo | undefined
    },

    addToQueue: (photoId: number, taskType: string, priority = 0): void => {
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
    peekNextTask: () => {
      return stmts.peekNextTask.get() as
        | { id: number; photoId: number; taskType: string }
        | undefined
    },
    completeTask: (taskId: number): void => {
      stmts.completeTask.run(taskId)
    },
    resetTask: (taskId: number): void => {
      stmts.resetTask.run(taskId)
    },
    failTask: (taskId: number, error: string): void => {
      stmts.failTask.run(error, taskId)
    },
    recoverStuckTasks: (): number => {
      return stmts.recoverStuckTasks.run().changes
    },
    requeueMissingEmbeddings: (): number => {
      const photos = stmts.getPhotosWithoutEmbedding.all() as Array<{ id: number }>
      for (const photo of photos) {
        stmts.addToQueue.run(photo.id, 'embed', 10)
      }
      return photos.length
    },
    getQueueStats: () => {
      const result = stmts.getQueueStats.get() as { pending: number; processing: number; done: number }
      return { pending: result.pending || 0, processing: result.processing || 0, done: result.done || 0 }
    },
    getPhotoStats: () => {
      const result = stmts.getPhotoStats.get() as {
        total: number; uniqueTotal: number; thumbnailed: number; indexed: number; captioned: number
      }
      return {
        total: result.total || 0,
        uniqueTotal: result.uniqueTotal || 0,
        thumbnailed: result.thumbnailed || 0,
        indexed: result.indexed || 0,
        captioned: result.captioned || 0,
      }
    },

    hasContentForHash: (fileHash: string) => {
      return {
        hasEmbedding: !!stmts.hasEmbeddingForHash.get(fileHash),
        hasCaption: !!stmts.hasCaptionForHash.get(fileHash),
      }
    },
    saveImageVec: (fileHash: string, embedding: Float32Array): void => {
      const buffer = vecToBuffer(embedding)
      stmts.saveImageVec.run(fileHash, buffer)
      stmts.updateEmbedStatusByHash.run(fileHash)
    },
    updateEmbedStatusByHash: (fileHash: string): void => {
      stmts.updateEmbedStatusByHash.run(fileHash)
    },
    saveCaption: (fileHash: string, text: string): void => {
      stmts.saveCaption.run(fileHash, text)
      stmts.updateCaptionStatusByHash.run(fileHash)
    },
    updateCaptionStatusByHash: (fileHash: string): void => {
      stmts.updateCaptionStatusByHash.run(fileHash)
    },
    getCaption: (fileHash: string): string | undefined => {
      const result = stmts.getCaption.get(fileHash) as { text: string } | undefined
      return result?.text
    },
    deleteContentByHash: (fileHash: string): void => {
      stmts.deleteImageVecByHash.run(fileHash)
      stmts.deleteCaptionByHash.run(fileHash)
    },

    searchByVec: (queryVec, limit) => {
      try {
        const allVecs = stmts.getAllImageVecs.all() as Array<{ file_hash: string; embedding: Buffer }>
        return allVecs
          .map((row) => ({
            fileHash: row.file_hash,
            distance: 1 - cosineSimilarity(queryVec, bufferToVec(row.embedding)),
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, limit)
      } catch (error) {
        console.error('Vector search error:', error)
        return []
      }
    },
    searchByText: (query, limit) => {
      try {
        const ftsQuery = query.trim().split(/\s+/).map((w) => `"${w}"`).join(' OR ')
        const results = stmts.searchByText.all(ftsQuery, limit) as Array<{ file_hash: string; score: number }>
        return results.map((row) => ({ fileHash: row.file_hash, score: Math.abs(row.score) }))
      } catch (error) {
        console.error('Text search error:', error)
        return []
      }
    },
    searchByFileName: (query, limit) => {
      const pattern = `%${query}%`
      const results = stmts.searchByFileName.all(pattern, pattern, limit) as Array<{ file_hash: string }>
      return results.map((r) => ({ fileHash: r.file_hash }))
    },
    getRepresentativePhotosFiltered: (limit, offset, dateFrom, dateTo) => {
      return stmts.getRepresentativePhotosFiltered.all(
        dateFrom || null, dateFrom || null,
        dateTo || null, dateTo || null,
        limit, offset
      ) as Photo[]
    },
    findSimilar: (fileHash, limit) => {
      try {
        const allVecs = stmts.getAllImageVecs.all() as Array<{ file_hash: string; embedding: Buffer }>
        const target = allVecs.find((v) => v.file_hash === fileHash)
        if (!target) return []
        const targetVec = bufferToVec(target.embedding)
        return allVecs
          .filter((v) => v.file_hash !== fileHash)
          .map((row) => ({
            fileHash: row.file_hash,
            distance: 1 - cosineSimilarity(targetVec, bufferToVec(row.embedding)),
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, limit)
      } catch (error) {
        console.error('Find similar error:', error)
        return []
      }
    },

    close: (): void => { db.close() },
  }
}

/** 检测旧 schema 并迁移 */
function migrateIfNeeded(db: Database.Database): void {
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(image_vecs)`).all() as Array<{ name: string }>
    const hasPhotoId = tableInfo.some((col) => col.name === 'photo_id')

    if (hasPhotoId) {
      console.log('Detected old schema, migrating to hash-based content tables...')

      // 先清空 FTS5 内容，再按正确顺序删除
      try { db.exec(`DELETE FROM captions_fts`) } catch { /* ignore */ }
      db.exec(`
        DROP TRIGGER IF EXISTS captions_ai;
        DROP TRIGGER IF EXISTS captions_ad;
        DROP TRIGGER IF EXISTS captions_au;
        DROP TABLE IF EXISTS captions_fts;
        DROP TABLE IF EXISTS captions;
        DROP TABLE IF EXISTS image_vecs;
      `)

      // 重置所有照片的处理状态
      db.exec(`
        UPDATE photos SET embed_status = 'pending', caption_status = 'pending', width = NULL, height = NULL;
        DELETE FROM index_queue;
      `)
      console.log('Migration complete. Photos will be re-indexed.')
    }
  } catch {
    // 表不存在，正常初始化
  }
}
