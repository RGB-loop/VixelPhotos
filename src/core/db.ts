import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import * as sqliteVec from 'sqlite-vec'
import type { Photo, WatchedFolder, PhotoDetail, PhotoLocation } from '../shared/types'
import { tokenizeForFtsSync } from './text/tokenize'

// 向量维度 - SigLIP 2 base/16-256
// 旧版用 2048 (Qwen3-VL-Embedding API)；migrateVectorDimension 会自动迁移
const EMBEDDING_DIM = 768

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

-- 图像向量映射表（file_hash → rowid 映射，vec0 需要 integer rowid）
CREATE TABLE IF NOT EXISTS image_vec_map (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE
);

-- 图像向量表（sqlite-vec ANN 索引）
CREATE VIRTUAL TABLE IF NOT EXISTS image_vecs USING vec0(
  embedding float[${EMBEDDING_DIM}]
);

-- Caption 全文搜索表 (FTS5, standalone — 通过触发器同步)
CREATE VIRTUAL TABLE IF NOT EXISTS captions_fts USING fts5(
  text,
  tokenize='unicode61'
);

-- FTS5 同步触发器（standalone FTS5 用普通 INSERT/DELETE）
-- jiebatok(text) UDF 在 better-sqlite3 启动时注册，做 CJK 分词，
-- ASCII 文本透传，jieba 不可用时回退为原文。
CREATE TRIGGER IF NOT EXISTS captions_ai AFTER INSERT ON captions BEGIN
  INSERT INTO captions_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;
CREATE TRIGGER IF NOT EXISTS captions_ad AFTER DELETE ON captions BEGIN
  DELETE FROM captions_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS captions_au AFTER UPDATE ON captions BEGIN
  DELETE FROM captions_fts WHERE rowid = old.id;
  INSERT INTO captions_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;

-- OCR 文本表（按 file_hash 去重共享）
-- 与 captions 分离的原因：captions 是用户手写的描述，image_ocr 是机器识别的图内文字，
-- 语义独立，搜索通道也分别打分（4-way RRF: vec + caption FTS5 + ocr FTS5 + filename）。
CREATE TABLE IF NOT EXISTS image_ocr (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS image_ocr_fts USING fts5(
  text,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS image_ocr_ai AFTER INSERT ON image_ocr BEGIN
  INSERT INTO image_ocr_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;
CREATE TRIGGER IF NOT EXISTS image_ocr_ad AFTER DELETE ON image_ocr BEGIN
  DELETE FROM image_ocr_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS image_ocr_au AFTER UPDATE ON image_ocr BEGIN
  DELETE FROM image_ocr_fts WHERE rowid = old.id;
  INSERT INTO image_ocr_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;

-- 人脸表
CREATE TABLE IF NOT EXISTS faces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL,
  face_index  INTEGER NOT NULL,
  bbox        TEXT NOT NULL,
  confidence  REAL NOT NULL,
  embedding   BLOB NOT NULL,
  person_id   INTEGER REFERENCES people(id),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_hash, face_index)
);

CREATE INDEX IF NOT EXISTS idx_faces_file_hash ON faces(file_hash);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

-- 人物表
CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  cover_face_id INTEGER,
  face_count  INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
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
  getPhotoStats: () => { total: number; uniqueTotal: number; thumbnailed: number; indexed: number; captioned: number; ocred: number }

  // 内容操作（按 file_hash 共享）
  hasContentForHash: (fileHash: string) => { hasEmbedding: boolean; hasCaption: boolean; hasOcr: boolean }
  saveImageVec: (fileHash: string, embedding: Float32Array) => void
  updateEmbedStatusByHash: (fileHash: string) => void
  saveCaption: (fileHash: string, text: string) => void
  updateCaptionStatusByHash: (fileHash: string) => void
  getCaption: (fileHash: string) => string | undefined
  saveOcrText: (fileHash: string, text: string) => void
  getOcrText: (fileHash: string) => string | undefined
  getPendingOcrPhotos: () => Array<{ id: number; fileHash: string; filePath: string }>
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
  searchByOcr: (
    query: string,
    limit: number
  ) => Array<{ fileHash: string; score: number }>
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
  getPhotosWithGPS: (limit?: number) => Photo[]

  // 人脸
  saveFace: (fileHash: string, faceIndex: number, bbox: string, confidence: number, embedding: Float32Array) => number
  updateFaceStatusByHash: (fileHash: string) => void
  hasFacesForHash: (fileHash: string) => boolean
  getFacesByHash: (fileHash: string) => Array<{ id: number; faceIndex: number; bbox: string; confidence: number; personId: number | null; personName: string | null }>
  getAllFaceEmbeddings: () => Array<{ id: number; embedding: Float32Array; confidence: number; personId: number | null }>
  setFacePersonId: (faceId: number, personId: number) => void
  createPerson: (coverFaceId: number) => number
  updatePersonFaceCount: (personId: number) => void
  getPeople: () => Array<{ id: number; name: string | null; coverFaceId: number | null; faceCount: number; photoCount: number; createdAt: string }>
  getPersonPhotos: (personId: number, limit?: number) => Photo[]
  updatePersonName: (personId: number, name: string) => void
  mergePeople: (targetId: number, sourceIds: number[]) => void
  getPendingFacePhotos: () => Array<{ id: number; fileHash: string; filePath: string }>
  getFaceCoverInfo: (faceId: number) => { fileHash: string; bbox: string } | undefined

  // 关闭
  close: () => void
}


export function initDatabase(dbPath: string, options?: { runCleanup?: boolean }): DatabaseInstance {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  // 加载 sqlite-vec 向量搜索扩展
  sqliteVec.load(db)
  console.log('sqlite-vec loaded:', (db.prepare('select vec_version()').get() as Record<string, string>)['vec_version()'])

  // 注册 jiebatok(text) UDF —— FTS5 触发器调用它做 CJK 分词。
  // deterministic: true 允许 SQLite 缓存结果（同一文本只切一次）。
  db.function('jiebatok', { deterministic: true, varargs: false }, (text: unknown): string => {
    if (typeof text !== 'string' || text.length === 0) return ''
    return tokenizeForFtsSync(text)
  })

  // 检测旧 schema 并迁移
  migrateIfNeeded(db)
  migrateToVec0(db)
  migrateVectorDimension(db, EMBEDDING_DIM)
  migrateFtsTriggersToJieba(db)

  db.exec(SCHEMA)

  // WAL checkpoint — 确保其他进程写入的数据对当前连接可见
  db.pragma('wal_checkpoint(PASSIVE)')

  // 确保新列存在
  ensureFaceStatusColumn(db)
  if (options?.runCleanup !== false) {
    cleanupStaleVecMap(db)
  }

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
        AND p.file_hash NOT IN (SELECT file_hash FROM image_vec_map)
        AND p.id NOT IN (SELECT photo_id FROM index_queue WHERE task_type IN ('embed', 'thumbnail') AND status IN ('pending', 'processing'))
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
        COUNT(DISTINCT p.file_hash) as uniqueTotal,
        SUM(CASE WHEN p.width IS NOT NULL THEN 1 ELSE 0 END) as thumbnailed,
        SUM(CASE WHEN p.embed_status = 'done' THEN 1 ELSE 0 END) as indexed,
        SUM(CASE WHEN p.caption_status = 'done' THEN 1 ELSE 0 END) as captioned,
        (SELECT COUNT(DISTINCT file_hash) FROM image_ocr) as ocred
      FROM photos p
      WHERE p.deleted_at IS NULL
    `),

    // 内容操作（按 file_hash）
    hasEmbeddingForHash: db.prepare(`
      SELECT 1 FROM image_vec_map m
      JOIN image_vecs v ON v.rowid = m.rowid
      WHERE m.file_hash = ?
    `),
    hasCaptionForHash: db.prepare(`SELECT 1 FROM captions WHERE file_hash = ?`),
    hasOcrForHash: db.prepare(`SELECT 1 FROM image_ocr WHERE file_hash = ?`),
    insertVecMap: db.prepare(`
      INSERT OR IGNORE INTO image_vec_map (file_hash) VALUES (?)
    `),
    getVecMapRowid: db.prepare(`SELECT rowid FROM image_vec_map WHERE file_hash = ?`),
    getVecByRowid: db.prepare(`SELECT embedding FROM image_vecs WHERE rowid = ?`),
    insertVec: db.prepare(`
      INSERT INTO image_vecs (rowid, embedding) VALUES (?, ?)
    `),
    updateVec: db.prepare(`
      UPDATE image_vecs SET embedding = ? WHERE rowid = ?
    `),
    deleteVecByRowid: db.prepare(`DELETE FROM image_vecs WHERE rowid = ?`),
    deleteVecMapByHash: db.prepare(`DELETE FROM image_vec_map WHERE file_hash = ?`),
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
    saveOcrText: db.prepare(`
      INSERT INTO image_ocr (file_hash, text) VALUES (?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET text = excluded.text, detected_at = CURRENT_TIMESTAMP
    `),
    getOcrText: db.prepare(`SELECT text FROM image_ocr WHERE file_hash = ?`),
    deleteOcrByHash: db.prepare(`DELETE FROM image_ocr WHERE file_hash = ?`),
    // 等待 OCR 的照片：已有 embedding 但还没 OCR 结果
    getPendingOcrPhotos: db.prepare(`
      SELECT p.id, p.file_hash as fileHash, p.file_path as filePath
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.file_hash IS NOT NULL
        AND p.embed_status = 'done'
        AND p.file_hash NOT IN (SELECT file_hash FROM image_ocr)
        AND p.id NOT IN (SELECT photo_id FROM index_queue WHERE task_type = 'ocr' AND status IN ('pending', 'processing'))
      GROUP BY p.file_hash
    `),
    deleteImageVecByHash: db.prepare(`SELECT rowid FROM image_vec_map WHERE file_hash = ?`), // used to get rowid for vec deletion
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
    // KNN 向量搜索（sqlite-vec）
    // sqlite-vec KNN: 先查 rowid+distance，再通过 map 映射到 file_hash
    searchVecKnnRaw: db.prepare(`
      SELECT rowid, distance
      FROM image_vecs
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `),
    getHashByRowid: db.prepare(`SELECT file_hash FROM image_vec_map WHERE rowid = ?`),
    // 获取所有向量（用于 face clustering 等需要全量向量的场景）
    getAllImageVecs: db.prepare(`
      SELECT m.file_hash, v.embedding
      FROM image_vecs v
      JOIN image_vec_map m ON m.rowid = v.rowid
    `),
    // 文件名搜索（LIKE 模糊匹配，按 hash 去重）
    searchByFileName: db.prepare(`
      SELECT DISTINCT file_hash FROM photos
      WHERE deleted_at IS NULL AND (file_name LIKE ? OR file_path LIKE ?)
      LIMIT ?
    `),
    // OCR 全文搜索（FTS5 BM25）
    searchByOcr: db.prepare(`
      SELECT o.file_hash, bm25(image_ocr_fts) as score
      FROM image_ocr_fts
      JOIN image_ocr o ON image_ocr_fts.rowid = o.id
      WHERE image_ocr_fts MATCH ?
      ORDER BY score
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
    getPhotosWithGPS: db.prepare(`
      SELECT p.id, p.folder_id as folderId, p.file_path as filePath, p.file_name as fileName,
             p.file_size as fileSize, p.file_mtime as fileMtime, p.file_hash as fileHash,
             p.width, p.height, p.taken_at as takenAt, p.lat, p.lng,
             p.embed_status as embedStatus, p.caption_status as captionStatus,
             p.deleted_at as deletedAt, p.created_at as createdAt, p.updated_at as updatedAt
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.lat IS NOT NULL AND p.lng IS NOT NULL
        AND p.id = (
          SELECT MIN(p3.id) FROM photos p3
          WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL
        )
      ORDER BY p.taken_at DESC
      LIMIT ?
    `),

    // 人脸相关
    saveFace: db.prepare(`
      INSERT INTO faces (file_hash, face_index, bbox, confidence, embedding)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_hash, face_index) DO UPDATE SET
        bbox = excluded.bbox, confidence = excluded.confidence, embedding = excluded.embedding
      RETURNING id
    `),
    updateFaceStatusByHash: db.prepare(`
      UPDATE photos SET face_status = 'done' WHERE file_hash = ? AND deleted_at IS NULL
    `),
    hasFacesForHash: db.prepare(`SELECT 1 FROM faces WHERE file_hash = ? LIMIT 1`),
    getFacesByHash: db.prepare(`
      SELECT f.id, f.face_index as faceIndex, f.bbox, f.confidence, f.person_id as personId, p.name as personName
      FROM faces f
      LEFT JOIN people p ON f.person_id = p.id
      WHERE f.file_hash = ?
      ORDER BY f.face_index
    `),
    getAllFaceEmbeddings: db.prepare(`
      SELECT id, embedding, confidence, person_id as personId FROM faces
    `),
    createPerson: db.prepare(`
      INSERT INTO people (name, cover_face_id, face_count) VALUES (NULL, ?, 1) RETURNING id
    `),
    updatePersonFaceCount: db.prepare(`
      UPDATE people SET
        face_count = (SELECT COUNT(*) FROM faces WHERE person_id = people.id),
        cover_face_id = (SELECT id FROM faces WHERE person_id = people.id ORDER BY confidence DESC LIMIT 1)
      WHERE id = ?
    `),
    getPeople: db.prepare(`
      SELECT p.id, p.name, p.cover_face_id as coverFaceId, p.face_count as faceCount,
             (SELECT COUNT(DISTINCT f.file_hash) FROM faces f WHERE f.person_id = p.id) as photoCount,
             p.created_at as createdAt
      FROM people p
      WHERE p.face_count > 0
      ORDER BY photoCount DESC
    `),
    getPersonPhotos: db.prepare(`
      SELECT ph.id, ph.folder_id as folderId, ph.file_path as filePath, ph.file_name as fileName,
             ph.file_size as fileSize, ph.file_mtime as fileMtime, ph.file_hash as fileHash,
             ph.width, ph.height, ph.taken_at as takenAt, ph.lat, ph.lng,
             ph.embed_status as embedStatus, ph.caption_status as captionStatus,
             ph.deleted_at as deletedAt, ph.created_at as createdAt, ph.updated_at as updatedAt
      FROM photos ph
      WHERE ph.deleted_at IS NULL
        AND ph.file_hash IN (SELECT DISTINCT f.file_hash FROM faces f WHERE f.person_id = ?)
        AND ph.id = (
          SELECT MIN(p2.id) FROM photos p2
          WHERE p2.file_hash = ph.file_hash AND p2.deleted_at IS NULL
        )
      ORDER BY ph.taken_at DESC
      LIMIT ?
    `),
    updatePersonName: db.prepare(`UPDATE people SET name = ? WHERE id = ?`),
    mergePeopleFaces: db.prepare(`UPDATE faces SET person_id = ? WHERE person_id = ?`),
    deletePerson: db.prepare(`DELETE FROM people WHERE id = ?`),
    getPendingFacePhotos: db.prepare(`
      SELECT p.id, p.file_hash as fileHash, p.file_path as filePath
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND (p.face_status IS NULL OR p.face_status = 'pending')
        AND p.id = (
          SELECT MIN(p2.id) FROM photos p2
          WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL
        )
    `),
    setFacePersonId: db.prepare(`UPDATE faces SET person_id = ? WHERE id = ?`),
    getFaceCoverInfo: db.prepare(`SELECT file_hash as fileHash, bbox FROM faces WHERE id = ?`),
    checkFaceStatusColumn: db.prepare(`SELECT face_status FROM photos LIMIT 0`),
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
        total: number; uniqueTotal: number; thumbnailed: number; indexed: number; captioned: number; ocred: number
      }
      return {
        total: result.total || 0,
        uniqueTotal: result.uniqueTotal || 0,
        thumbnailed: result.thumbnailed || 0,
        indexed: result.indexed || 0,
        captioned: result.captioned || 0,
        ocred: result.ocred || 0,
      }
    },

    hasContentForHash: (fileHash: string) => {
      return {
        hasEmbedding: !!stmts.hasEmbeddingForHash.get(fileHash),
        hasCaption: !!stmts.hasCaptionForHash.get(fileHash),
        hasOcr: !!stmts.hasOcrForHash.get(fileHash),
      }
    },
    saveImageVec: (fileHash: string, embedding: Float32Array): void => {
      // vec0 要求: rowid 必须是 BigInt, embedding 必须是 Float32Array（不是 Buffer）
      let mapRowid: bigint | undefined
      try {
        const info = stmts.insertVecMap.run(fileHash)
        if (info.changes > 0) {
          mapRowid = BigInt(info.lastInsertRowid)
        }
      } catch { /* conflict */ }
      if (mapRowid === undefined) {
        const existing = stmts.getVecMapRowid.get(fileHash) as { rowid: bigint | number } | undefined
        if (existing) mapRowid = BigInt(existing.rowid)
      }
      if (mapRowid !== undefined) {
        try {
          stmts.insertVec.run(mapRowid, embedding)
        } catch {
          try { stmts.updateVec.run(embedding, mapRowid) } catch { /* ignore */ }
        }
      }
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
    saveOcrText: (fileHash: string, text: string): void => {
      stmts.saveOcrText.run(fileHash, text)
    },
    getOcrText: (fileHash: string): string | undefined => {
      const result = stmts.getOcrText.get(fileHash) as { text: string } | undefined
      return result?.text
    },
    getPendingOcrPhotos: () => {
      return stmts.getPendingOcrPhotos.all() as Array<{ id: number; fileHash: string; filePath: string }>
    },
    deleteContentByHash: (fileHash: string): void => {
      // 删除向量：先查 rowid，再删 vec0 行和映射
      const row = stmts.deleteImageVecByHash.get(fileHash) as { rowid: bigint | number } | undefined
      if (row) {
        stmts.deleteVecByRowid.run(Number(row.rowid))
        stmts.deleteVecMapByHash.run(fileHash)
      }
      stmts.deleteCaptionByHash.run(fileHash)
      stmts.deleteOcrByHash.run(fileHash)
    },

    searchByVec: (queryVec, limit) => {
      try {
        // vec0 MATCH 接受 Float32Array
        const knnResults = stmts.searchVecKnnRaw.all(queryVec, limit) as Array<{ rowid: bigint | number; distance: number }>
        return knnResults
          .map((r) => {
            const hashRow = stmts.getHashByRowid.get(Number(r.rowid)) as { file_hash: string } | undefined
            return hashRow ? { fileHash: hashRow.file_hash, distance: r.distance } : null
          })
          .filter((r): r is { fileHash: string; distance: number } => r !== null)
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
    searchByOcr: (query, limit) => {
      try {
        const ftsQuery = query.trim().split(/\s+/).map((w) => `"${w}"`).join(' OR ')
        const results = stmts.searchByOcr.all(ftsQuery, limit) as Array<{ file_hash: string; score: number }>
        return results.map((row) => ({ fileHash: row.file_hash, score: Math.abs(row.score) }))
      } catch (error) {
        console.error('OCR search error:', error)
        return []
      }
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
        const mapRow = stmts.getVecMapRowid.get(fileHash) as { rowid: bigint | number } | undefined
        if (!mapRow) return []
        const vecRow = stmts.getVecByRowid.get(Number(mapRow.rowid)) as { embedding: Buffer } | undefined
        if (!vecRow) return []
        // vec0 返回的 embedding 是 Buffer，需要转 Float32Array 给 MATCH
        const targetVec = new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4)
        const knnResults = stmts.searchVecKnnRaw.all(targetVec, limit + 1) as Array<{ rowid: bigint | number; distance: number }>
        return knnResults
          .map((r) => {
            const hashRow = stmts.getHashByRowid.get(Number(r.rowid)) as { file_hash: string } | undefined
            return hashRow ? { fileHash: hashRow.file_hash, distance: r.distance } : null
          })
          .filter((r): r is { fileHash: string; distance: number } => r !== null && r.fileHash !== fileHash)
          .slice(0, limit)
      } catch (error) {
        console.error('Find similar error:', error)
        return []
      }
    },

    getPhotosWithGPS: (limit = 5000) => {
      return stmts.getPhotosWithGPS.all(limit) as Photo[]
    },

    // 人脸
    saveFace: (fileHash, faceIndex, bbox, confidence, embedding) => {
      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
      const result = stmts.saveFace.get(fileHash, faceIndex, bbox, confidence, buffer) as { id: number }
      return result.id
    },
    updateFaceStatusByHash: (fileHash) => {
      stmts.updateFaceStatusByHash.run(fileHash)
    },
    hasFacesForHash: (fileHash) => {
      return !!stmts.hasFacesForHash.get(fileHash)
    },
    getFacesByHash: (fileHash) => {
      return stmts.getFacesByHash.all(fileHash) as Array<{
        id: number; faceIndex: number; bbox: string; confidence: number; personId: number | null; personName: string | null
      }>
    },
    getAllFaceEmbeddings: () => {
      const rows = stmts.getAllFaceEmbeddings.all() as Array<{ id: number; embedding: Buffer; confidence: number; personId: number | null }>
      return rows.map((r) => ({
        id: r.id,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
        confidence: r.confidence,
        personId: r.personId,
      }))
    },
    setFacePersonId: (faceId: number, personId: number): void => {
      stmts.setFacePersonId.run(personId, faceId)
    },
    createPerson: (coverFaceId: number): number => {
      const result = stmts.createPerson.get(coverFaceId) as { id: number }
      return result.id
    },
    updatePersonFaceCount: (personId: number): void => {
      stmts.updatePersonFaceCount.run(personId)
    },
    getPeople: () => {
      return stmts.getPeople.all() as Array<{
        id: number; name: string | null; coverFaceId: number | null; faceCount: number; photoCount: number; createdAt: string
      }>
    },
    getPersonPhotos: (personId, limit = 50) => {
      return stmts.getPersonPhotos.all(personId, limit) as Photo[]
    },
    updatePersonName: (personId, name) => {
      stmts.updatePersonName.run(name, personId)
    },
    mergePeople: (targetId, sourceIds) => {
      const transaction = db.transaction(() => {
        for (const sourceId of sourceIds) {
          stmts.mergePeopleFaces.run(targetId, sourceId)
          stmts.deletePerson.run(sourceId)
        }
        stmts.updatePersonFaceCount.run(targetId)
      })
      transaction()
    },
    getPendingFacePhotos: () => {
      return stmts.getPendingFacePhotos.all() as Array<{ id: number; fileHash: string; filePath: string }>
    },
    getFaceCoverInfo: (faceId) => {
      return stmts.getFaceCoverInfo.get(faceId) as { fileHash: string; bbox: string } | undefined
    },

    close: (): void => { db.close() },
  }
}

/**
 * 升级旧库的 FTS5 触发器：把 `new.text` 替换成 `jiebatok(new.text)`。
 *
 * 通过 sqlite_master.sql 的内容判断触发器是否已经包含 jiebatok 字串；
 * 已包含则视为已迁移；否则 DROP+CREATE 写入新版本。
 *
 * 注意：这一步只换触发器，不重建已有 FTS5 行。PR4.4 会按需 rebuild。
 */
function migrateFtsTriggersToJieba(db: Database.Database): void {
  const triggers = ['captions_ai', 'captions_au', 'image_ocr_ai', 'image_ocr_au']
  for (const name of triggers) {
    try {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`)
        .get(name) as { sql?: string } | undefined
      if (row?.sql && !row.sql.includes('jiebatok')) {
        db.exec(`DROP TRIGGER IF EXISTS ${name}`)
        // 让 SCHEMA 的 CREATE TRIGGER IF NOT EXISTS 在下游 db.exec(SCHEMA) 时创建新版
      }
    } catch (err) {
      console.warn(`[migrate] could not migrate trigger ${name}:`, err)
    }
  }
}

/**
 * 检测 image_vecs 的当前维度，与目标维度不一致时丢弃并重建。
 *
 * 触发场景：从外部 API (Qwen3-VL-Embedding, dim=2048) 切换到本地
 * SigLIP 2 (dim=768)。所有旧向量必须丢弃重做。
 */
function migrateVectorDimension(db: Database.Database, targetDim: number): void {
  try {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='image_vecs'`)
      .get() as { sql?: string } | undefined
    if (!row?.sql) return // 表还不存在，新建时会用正确维度

    // CREATE VIRTUAL TABLE image_vecs USING vec0(embedding float[2048])
    const m = row.sql.match(/float\[(\d+)\]/)
    if (!m) return
    const currentDim = parseInt(m[1], 10)
    if (currentDim === targetDim) return

    console.log(
      `[migrate] image_vecs dim ${currentDim} != target ${targetDim}, rebuilding`
    )
    db.exec(`
      DROP TABLE IF EXISTS image_vecs;
      DROP TABLE IF EXISTS image_vec_map;
      UPDATE photos SET embed_status = 'pending' WHERE embed_status = 'done';
      DELETE FROM index_queue WHERE task_type = 'embed';
    `)
  } catch (err) {
    console.warn('[migrate] vector dimension migration failed:', err)
  }
}

/** 迁移 image_vecs 从普通表到 vec0 虚拟表 */
function migrateToVec0(db: Database.Database): void {
  try {
    // 检查 image_vecs 是否是普通表（有 file_hash 列 = 旧格式）
    const tableInfo = db.prepare(`PRAGMA table_info(image_vecs)`).all() as Array<{ name: string }>
    if (tableInfo.some((col) => col.name === 'file_hash')) {
      db.exec(`
        DROP TABLE IF EXISTS image_vecs;
        DROP TABLE IF EXISTS image_vec_map;
      `)
      // 重置 embed_status 让照片重新生成 embedding
      db.exec(`
        UPDATE photos SET embed_status = 'pending' WHERE embed_status = 'done';
        DELETE FROM index_queue WHERE task_type = 'embed';
      `)
    }
  } catch {
    // 表不存在或已经是 vec0
  }
}

/** 清理 image_vec_map 中没有对应 vec0 数据的孤立记录 */
function cleanupStaleVecMap(db: Database.Database): void {
  try {
    const stale = db.prepare(`
      SELECT m.rowid, m.file_hash FROM image_vec_map m
      WHERE m.rowid NOT IN (SELECT rowid FROM image_vecs)
    `).all() as Array<{ rowid: number; file_hash: string }>

    if (stale.length > 0) {
      const del = db.prepare('DELETE FROM image_vec_map WHERE rowid = ?')
      const resetEmbed = db.prepare("UPDATE photos SET embed_status = 'pending' WHERE file_hash = ? AND deleted_at IS NULL")
      for (const row of stale) {
        del.run(row.rowid)
        resetEmbed.run(row.file_hash)
      }
    }
  } catch {
    // 表可能还不存在
  }
}

/** 确保 face_status 列存在 */
function ensureFaceStatusColumn(db: Database.Database): void {
  try {
    db.prepare('SELECT face_status FROM photos LIMIT 0').get()
  } catch {
    db.exec('ALTER TABLE photos ADD COLUMN face_status TEXT DEFAULT \'pending\'')
  }
}

/** 检测旧 schema 并迁移 */
function migrateIfNeeded(db: Database.Database): void {
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(image_vecs)`).all() as Array<{ name: string }>
    const hasPhotoId = tableInfo.some((col) => col.name === 'photo_id')

    if (hasPhotoId) {
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
    }
  } catch {
    // 表不存在，正常初始化
  }
}
