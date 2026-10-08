import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import * as sqliteVec from 'sqlite-vec'
import type { Photo, WatchedFolder, PhotoDetail, PhotoLocation, VideoRecord } from '../shared/types'
import { tokenizeForFtsSync } from './text/tokenize'
import { buildFtsQuery } from './text/fts-query'

// 向量维度 - EmbeddingGemma 2 (768D，Matryoshka 可截断到 512/256/128)
const EMBEDDING_DIM = 768

// 人脸 embedding 维度 - MobileFaceNet 标准输出
// 与 src/core/face/embedding.ts 的 ONNX 模型保持一致
const FACE_EMBEDDING_DIM = 128

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
  face_status     TEXT DEFAULT 'pending',
  video_id        INTEGER REFERENCES videos(id),  -- 视频代表帧：来源视频
  frame_time_ms   INTEGER,                        -- 视频代表帧：时间戳
  deleted_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(embed_status);
CREATE INDEX IF NOT EXISTS idx_photos_video ON photos(video_id);
CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted_at);
CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(file_hash);

-- 索引任务队列
CREATE TABLE IF NOT EXISTS index_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id    INTEGER,          -- 多态：extract_frames 任务存 videos.id，其余存 photos.id，所以不加外键
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

-- OCR 文本表（按 file_hash 去重共享）
-- 与 captions（用户手写描述，不参与搜索）分离；OCR 是 4-way RRF 的 BM25 通道。
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

-- 人脸向量 ANN 索引（sqlite-vec），rowid == faces.id
-- 避免 assignFaceToPerson 在每次新脸入库时全表 O(N) JS 余弦扫描。
CREATE VIRTUAL TABLE IF NOT EXISTS face_vecs USING vec0(
  embedding float[${FACE_EMBEDDING_DIM}]
);

-- 人物表
CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  cover_face_id INTEGER,
  face_count  INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 内部状态 / 一次性迁移标记
CREATE TABLE IF NOT EXISTS meta_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 视频文件主表
-- 视频本身不索引；indexer 按 32s 切片，每片的帧序列 + 音轨合成一个向量，
-- 存入 video_segments / video_segment_vecs。缩略图仍走 photos（首帧代表图）。
CREATE TABLE IF NOT EXISTS videos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id    INTEGER REFERENCES watched_folders(id),
  file_path    TEXT NOT NULL UNIQUE,
  file_name    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  file_mtime   INTEGER NOT NULL,
  file_hash    TEXT,
  duration_ms  INTEGER,
  width        INTEGER,
  height       INTEGER,
  frame_count  INTEGER DEFAULT 0,
  deleted_at   DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id);
CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(file_hash);

-- 视频片段表（EmbeddingGemma 2 重构新增）
-- 长视频按 32s 分块，每个片段一个向量（帧序列 + 音轨 → 单向量）
-- 替代旧方案：photos.video_id / frame_time_ms（逐帧独立 embed）
CREATE TABLE IF NOT EXISTS video_segments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     INTEGER NOT NULL REFERENCES videos(id),
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  file_hash    TEXT NOT NULL,  -- 片段内容 hash（dedup 用）
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_video_segments_video ON video_segments(video_id);
CREATE INDEX IF NOT EXISTS idx_video_segments_hash ON video_segments(file_hash);

-- 视频片段向量（vec0 ANN 索引）
CREATE VIRTUAL TABLE IF NOT EXISTS video_segment_vecs USING vec0(
  embedding float[${EMBEDDING_DIM}]
);

-- 片段向量映射表（segment_id → rowid）
CREATE TABLE IF NOT EXISTS video_segment_vec_map (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id  INTEGER NOT NULL UNIQUE REFERENCES video_segments(id)
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
    fileHash: string,
    /** 视频帧 provenance（可选）—— 若提供，该 photos 行就是该视频在某个时间戳的关键帧 */
    videoCtx?: { videoId: number; frameTimeMs: number }
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
  getPhotoStats: () => { total: number; uniqueTotal: number; thumbnailed: number; indexed: number; ocred: number }

  // 内容操作（按 file_hash 共享）
  hasContentForHash: (fileHash: string) => { hasEmbedding: boolean; hasCaption: boolean; hasOcr: boolean }
  saveImageVec: (fileHash: string, embedding: Float32Array) => void
  updateEmbedStatusByHash: (fileHash: string) => void
  saveCaption: (fileHash: string, text: string) => void
  getCaption: (fileHash: string) => string | undefined
  saveOcrText: (fileHash: string, text: string) => void
  getOcrText: (fileHash: string) => string | undefined
  getPendingOcrPhotos: () => Array<{ id: number; fileHash: string; filePath: string }>
  deleteContentByHash: (fileHash: string) => void

  // 视频片段（EmbeddingGemma 2：帧序列 + 音轨 → 单向量）
  saveVideoSegment: (
    videoId: number,
    startMs: number,
    endMs: number,
    fileHash: string,
    embedding: Float32Array
  ) => number
  hasVideoSegmentForHash: (fileHash: string) => boolean
  getVideoSegments: (videoId: number) => Array<{
    id: number
    videoId: number
    startMs: number
    endMs: number
    fileHash: string
  }>
  deleteVideoSegments: (videoId: number) => void
  searchVideoSegmentsByVec: (
    queryVec: Float32Array,
    limit: number
  ) => Array<{ segmentId: number; videoId: number; startMs: number; endMs: number; distance: number }>

  // 搜索
  searchByVec: (
    queryVec: Float32Array,
    limit: number
  ) => Array<{ fileHash: string; distance: number }>
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
  /**
   * 在 face_vecs 上跑 vec0 KNN，返回距离 ≤ maxDistance 的最近邻。
   *
   * 与全量 getAllFaceEmbeddings + JS 余弦相比：1k 人脸库 50ms → < 1ms。
   * 失败（如 face_vecs 维度不匹配、未启用 vec0）时返回 []，调用方自行回退。
   */
  searchFaceKnn: (
    queryVec: Float32Array,
    k: number,
    excludeFaceId?: number
  ) => Array<{ faceId: number; personId: number | null; distance: number }>
  setFacePersonId: (faceId: number, personId: number) => void
  createPerson: (coverFaceId: number) => number
  updatePersonFaceCount: (personId: number) => void
  getPeople: () => Array<{ id: number; name: string | null; coverFaceId: number | null; faceCount: number; photoCount: number; createdAt: string }>
  getPersonPhotos: (personId: number, limit?: number) => Photo[]
  updatePersonName: (personId: number, name: string) => void
  mergePeople: (targetId: number, sourceIds: number[]) => void
  getPendingFacePhotos: () => Array<{ id: number; fileHash: string; filePath: string }>
  getFaceCoverInfo: (faceId: number) => { fileHash: string; bbox: string } | undefined

  // 视频
  addVideo: (
    folderId: number,
    filePath: string,
    fileName: string,
    fileSize: number,
    fileMtime: number,
    fileHash: string
  ) => number
  getVideoById: (id: number) => VideoRecord | undefined
  getVideoByPath: (path: string) => VideoRecord | undefined
  updateVideoMeta: (
    id: number,
    data: { durationMs?: number; width?: number; height?: number; frameCount?: number }
  ) => void
  softDeleteVideo: (path: string) => void
  getFramePhotosByVideo: (videoId: number) => Photo[]
  /**
   * 用户删了源视频文件后的级联清理：soft-delete video，
   * soft-delete 所有 frame photos，对孤立的 frame hash 做内容 GC。
   * 返回 { fileHash, orphanedFrameHashes }；调用方据此清理 JPG 帧目录。
   */
  cascadeRemoveVideo: (filePath: string) => {
    fileHash: string
    orphanedFrameHashes: string[]
  } | null
  /**
   * 重抽帧前的清理：soft-delete 该 videoId 已有的所有 frame photos，
   * 对孤立 hash 做内容 GC。**不动 videos 表本身**。
   * 返回 orphanedFrameHashes，调用方据此清磁盘 JPG / 缩略图。
   */
  removeFramesForVideo: (videoId: number) => string[]

  // 备份
  /**
   * 用 SQLite online backup API 将 library.db 复制到 destPath。
   * better-sqlite3 的 .backup() 是异步、安全 — 不阻塞读写，WAL 模式兼容。
   */
  backupTo: (destPath: string) => Promise<void>
  /** 读取 meta_state 任一键（备份时间戳等小状态） */
  getMetaState: (key: string) => string | undefined
  /** 写入 meta_state 任一键 */
  setMetaState: (key: string, value: string) => void

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

  db.exec(SCHEMA)

  // WAL checkpoint — 确保其他进程写入的数据对当前连接可见
  db.pragma('wal_checkpoint(PASSIVE)')

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
      INSERT INTO photos (folder_id, file_path, file_name, file_size, file_mtime, file_hash, video_id, frame_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        file_hash = excluded.file_hash,
        -- 直接覆盖：调用方明确知道当前路径是不是视频帧，COALESCE 会导致
        -- 旧的 video_id 在路径转身份（视频帧 → 普通照片）时残留，触发
        -- search.ts 的 dedup-by-video 错误丢弃。
        video_id = excluded.video_id,
        frame_time_ms = excluded.frame_time_ms,
        deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `),

    // 视频表 CRUD
    addVideo: db.prepare(`
      INSERT INTO videos (folder_id, file_path, file_name, file_size, file_mtime, file_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        file_hash = excluded.file_hash,
        deleted_at = NULL
      RETURNING id
    `),
    getVideoById: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             duration_ms as durationMs, width, height, frame_count as frameCount,
             deleted_at as deletedAt, created_at as createdAt
      FROM videos WHERE id = ?
    `),
    getVideoByPath: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             duration_ms as durationMs, width, height, frame_count as frameCount,
             deleted_at as deletedAt, created_at as createdAt
      FROM videos WHERE file_path = ?
    `),
    updateVideoMeta: db.prepare(`
      UPDATE videos SET
        duration_ms = COALESCE(?, duration_ms),
        width       = COALESCE(?, width),
        height      = COALESCE(?, height),
        frame_count = COALESCE(?, frame_count)
      WHERE id = ?
    `),
    softDeleteVideo: db.prepare(`
      UPDATE videos SET deleted_at = CURRENT_TIMESTAMP WHERE file_path = ?
    `),
    getFramePhotosByVideo: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, video_id as videoId, frame_time_ms as frameTimeMs,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos
      WHERE video_id = ? AND deleted_at IS NULL
      ORDER BY frame_time_ms ASC
    `),

    // 照片字段映射（复用）
    getPhoto: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, video_id as videoId, frame_time_ms as frameTimeMs,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos WHERE id = ?
    `),
    getPhotoByPath: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, video_id as videoId, frame_time_ms as frameTimeMs,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos WHERE file_path = ?
    `),
    getPhotos: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, video_id as videoId, frame_time_ms as frameTimeMs,
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
             p.embed_status as embedStatus, p.video_id as videoId, p.frame_time_ms as frameTimeMs,
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
             p.embed_status as embedStatus, p.video_id as videoId, p.frame_time_ms as frameTimeMs,
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
             p.embed_status as embedStatus, p.video_id as videoId, p.frame_time_ms as frameTimeMs,
             p.deleted_at as deletedAt, p.created_at as createdAt, p.updated_at as updatedAt,
             c.text as caption,
             o.text as ocrText
      FROM photos p
      LEFT JOIN captions c ON p.file_hash = c.file_hash
      LEFT JOIN image_ocr o ON p.file_hash = o.file_hash
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
      UPDATE photos SET embed_status = 'done', updated_at = CURRENT_TIMESTAMP
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
    // 时长已知（非损坏）却没有任何片段向量的视频 —— 典型是索引时模型未就绪
    getVideosWithoutSegments: db.prepare(`
      SELECT v.id FROM videos v
      WHERE v.deleted_at IS NULL
        AND v.duration_ms > 0
        AND v.id NOT IN (SELECT video_id FROM video_segments)
        AND v.id NOT IN (SELECT photo_id FROM index_queue WHERE task_type = 'extract_frames' AND status IN ('pending', 'processing'))
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

    // ─── 视频片段 ────────────────────────────────────────────────
    insertVideoSegment: db.prepare(`
      INSERT INTO video_segments (video_id, start_ms, end_ms, file_hash)
      VALUES (?, ?, ?, ?)
    `),
    insertVideoSegmentVecMap: db.prepare(`
      INSERT OR IGNORE INTO video_segment_vec_map (segment_id) VALUES (?)
    `),
    getVideoSegmentVecRowid: db.prepare(`
      SELECT rowid FROM video_segment_vec_map WHERE segment_id = ?
    `),
    insertVideoSegmentVec: db.prepare(`
      INSERT INTO video_segment_vecs (rowid, embedding) VALUES (?, ?)
    `),
    updateVideoSegmentVec: db.prepare(`
      UPDATE video_segment_vecs SET embedding = ? WHERE rowid = ?
    `),
    hasVideoSegmentForHash: db.prepare(`
      SELECT 1 FROM video_segments WHERE file_hash = ?
    `),
    getVideoSegmentsByVideo: db.prepare(`
      SELECT id, video_id as videoId, start_ms as startMs, end_ms as endMs, file_hash as fileHash
      FROM video_segments WHERE video_id = ? ORDER BY start_ms
    `),
    getVideoSegmentIdsByVideo: db.prepare(`
      SELECT id FROM video_segments WHERE video_id = ?
    `),
    deleteVideoSegmentVec: db.prepare(`
      DELETE FROM video_segment_vecs WHERE rowid = ?
    `),
    deleteVideoSegmentVecMap: db.prepare(`
      DELETE FROM video_segment_vec_map WHERE segment_id = ?
    `),
    deleteVideoSegmentsByVideo: db.prepare(`
      DELETE FROM video_segments WHERE video_id = ?
    `),
    // 片段 KNN：先拿 rowid + distance，再 join 回 segments
    searchVideoSegmentKnnRaw: db.prepare(`
      SELECT rowid, distance
      FROM video_segment_vecs
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `),
    getVideoSegmentByVecRowid: db.prepare(`
      SELECT s.id as segmentId, s.video_id as videoId,
             s.start_ms as startMs, s.end_ms as endMs
      FROM video_segment_vec_map m
      JOIN video_segments s ON s.id = m.segment_id
      WHERE m.rowid = ?
    `),
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
             p.embed_status as embedStatus, p.video_id as videoId, p.frame_time_ms as frameTimeMs,
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
             p.embed_status as embedStatus, p.video_id as videoId, p.frame_time_ms as frameTimeMs,
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
    // 写入 face_vecs（与 faces.id 同 rowid）。INSERT OR REPLACE 处理 ON CONFLICT 路径。
    insertFaceVec: db.prepare(`
      INSERT INTO face_vecs(rowid, embedding) VALUES (?, ?)
    `),
    updateFaceVec: db.prepare(`
      UPDATE face_vecs SET embedding = ? WHERE rowid = ?
    `),
    deleteFaceVec: db.prepare(`
      DELETE FROM face_vecs WHERE rowid = ?
    `),
    // 给 deleteContentByHash 用：先按 hash 找到 faces.id，再删 face_vecs + faces
    getFaceIdsByHash: db.prepare(`SELECT id FROM faces WHERE file_hash = ?`),
    deleteFacesByHash: db.prepare(`DELETE FROM faces WHERE file_hash = ?`),
    // KNN：rowid 即 faces.id；join faces 拿 person_id
    searchFaceKnnRaw: db.prepare(`
      SELECT v.rowid as faceId, f.person_id as personId, v.distance
      FROM face_vecs v
      JOIN faces f ON f.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
      ORDER BY v.distance
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
             ph.embed_status as embedStatus, ph.deleted_at as deletedAt, ph.created_at as createdAt, ph.updated_at as updatedAt
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

      // 孤立 hash 全套内容清理：vec0 / 人脸 ANN / 人脸 BLOB / captions / OCR
      // 透过 deleteContentByHash 走同一套逻辑，避免日后再分叉
      const finalize = db.transaction(() => {
        for (const hash of orphanedHashes) {
          // 内联 deleteContentByHash 的实现（这里不能调外层 instance 方法 — 还没构造完）
          const row = stmts.deleteImageVecByHash.get(hash) as { rowid: bigint | number } | undefined
          if (row) {
            stmts.deleteVecByRowid.run(Number(row.rowid))
            stmts.deleteVecMapByHash.run(hash)
          }
          const faceRows = stmts.getFaceIdsByHash.all(hash) as Array<{ id: number }>
          for (const f of faceRows) stmts.deleteFaceVec.run(f.id)
          stmts.deleteFacesByHash.run(hash)
          stmts.deleteCaptionByHash.run(hash)
          stmts.deleteOcrByHash.run(hash)
        }
      })
      finalize()

      return orphanedHashes // 调用方用于清理缩略图文件
    },

    addPhoto: (folderId, filePath, fileName, fileSize, fileMtime, fileHash, videoCtx): number => {
      const result = stmts.addPhoto.get(
        folderId, filePath, fileName, fileSize, fileMtime, fileHash,
        videoCtx?.videoId ?? null,
        videoCtx?.frameTimeMs ?? null,
      ) as { id: number }
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
      const videos = stmts.getVideosWithoutSegments.all() as Array<{ id: number }>
      for (const video of videos) {
        stmts.addToQueue.run(video.id, 'extract_frames', 15)
      }
      return photos.length + videos.length
    },
    getQueueStats: () => {
      const result = stmts.getQueueStats.get() as { pending: number; processing: number; done: number }
      return { pending: result.pending || 0, processing: result.processing || 0, done: result.done || 0 }
    },
    getPhotoStats: () => {
      const result = stmts.getPhotoStats.get() as {
        total: number; uniqueTotal: number; thumbnailed: number; indexed: number; ocred: number
      }
      return {
        total: result.total || 0,
        uniqueTotal: result.uniqueTotal || 0,
        thumbnailed: result.thumbnailed || 0,
        indexed: result.indexed || 0,
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
      //
      // 失败语义：image_vec_map 和 image_vecs 必须保持一致 — 要么两表都有
      // 这个 hash，要么都没有。我们用事务包住 INSERT/UPDATE 两步；任何
      // 一步抛错就回滚，避免 vec_map 出现孤立 rowid（要等 cleanupStaleVecMap
      // 下次启动才回收）。
      const tx = db.transaction((hash: string, vec: Float32Array) => {
        // 1. 拿到 map rowid（新建或复用）
        let mapRowid: bigint
        const info = stmts.insertVecMap.run(hash)
        if (info.changes > 0) {
          mapRowid = BigInt(info.lastInsertRowid)
        } else {
          const existing = stmts.getVecMapRowid.get(hash) as { rowid: bigint | number } | undefined
          if (!existing) throw new Error(`Vec map row missing for hash ${hash}`)
          mapRowid = BigInt(existing.rowid)
        }
        // 2. INSERT；冲突走 UPDATE
        try {
          stmts.insertVec.run(mapRowid, vec)
        } catch {
          stmts.updateVec.run(vec, mapRowid)
        }
      })

      try {
        tx(fileHash, embedding)
        stmts.updateEmbedStatusByHash.run(fileHash)
      } catch (err) {
        console.warn(`saveImageVec failed for ${fileHash}:`, err)
        // 兜底：万一事务部分成功（理论上不该），也把可能的孤立 map 行清掉
        try { stmts.deleteVecMapByHash.run(fileHash) } catch { /* ignore */ }
        throw err
      }
    },
    updateEmbedStatusByHash: (fileHash: string): void => {
      stmts.updateEmbedStatusByHash.run(fileHash)
    },
    saveCaption: (fileHash: string, text: string): void => {
      stmts.saveCaption.run(fileHash, text)
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

    // ─── 视频片段 ────────────────────────────────────────────────
    saveVideoSegment: (
      videoId: number,
      startMs: number,
      endMs: number,
      fileHash: string,
      embedding: Float32Array
    ): number => {
      // 与 saveImageVec 同构：segments / vec_map / vecs 三表必须一致，
      // 任何一步失败就整体回滚，不留孤立 rowid。
      const tx = db.transaction(() => {
        const info = stmts.insertVideoSegment.run(videoId, startMs, endMs, fileHash)
        const segmentId = Number(info.lastInsertRowid)

        let mapRowid: bigint
        const mapInfo = stmts.insertVideoSegmentVecMap.run(segmentId)
        if (mapInfo.changes > 0) {
          mapRowid = BigInt(mapInfo.lastInsertRowid)
        } else {
          const existing = stmts.getVideoSegmentVecRowid.get(segmentId) as
            | { rowid: bigint | number }
            | undefined
          if (!existing) throw new Error(`Vec map row missing for segment ${segmentId}`)
          mapRowid = BigInt(existing.rowid)
        }

        try {
          stmts.insertVideoSegmentVec.run(mapRowid, embedding)
        } catch {
          stmts.updateVideoSegmentVec.run(embedding, mapRowid)
        }
        return segmentId
      })

      return tx() as number
    },
    hasVideoSegmentForHash: (fileHash: string): boolean => {
      return !!stmts.hasVideoSegmentForHash.get(fileHash)
    },
    getVideoSegments: (videoId: number) => {
      return stmts.getVideoSegmentsByVideo.all(videoId) as Array<{
        id: number
        videoId: number
        startMs: number
        endMs: number
        fileHash: string
      }>
    },
    deleteVideoSegments: (videoId: number): void => {
      // 先收集 segment id，逐个删 vec0 行和映射，最后删 segments
      const ids = stmts.getVideoSegmentIdsByVideo.all(videoId) as Array<{ id: number }>
      const tx = db.transaction(() => {
        for (const { id } of ids) {
          const row = stmts.getVideoSegmentVecRowid.get(id) as
            | { rowid: bigint | number }
            | undefined
          if (row) {
            try { stmts.deleteVideoSegmentVec.run(BigInt(row.rowid)) } catch { /* ignore */ }
          }
          try { stmts.deleteVideoSegmentVecMap.run(id) } catch { /* ignore */ }
        }
        stmts.deleteVideoSegmentsByVideo.run(videoId)
      })
      try {
        tx()
      } catch (err) {
        console.warn(`deleteVideoSegments failed for video ${videoId}:`, err)
      }
    },
    searchVideoSegmentsByVec: (queryVec: Float32Array, limit: number) => {
      try {
        const rows = stmts.searchVideoSegmentKnnRaw.all(queryVec, limit) as Array<{
          rowid: bigint | number
          distance: number
        }>
        const out: Array<{
          segmentId: number
          videoId: number
          startMs: number
          endMs: number
          distance: number
        }> = []
        for (const r of rows) {
          const seg = stmts.getVideoSegmentByVecRowid.get(Number(r.rowid)) as
            | { segmentId: number; videoId: number; startMs: number; endMs: number }
            | undefined
          if (seg) out.push({ ...seg, distance: r.distance })
        }
        return out
      } catch (err) {
        // 与 searchFaceKnn 同样的回退语义：vec0 没就绪就返回空，调用方自行降级
        console.warn('searchVideoSegmentsByVec failed (vec0 may not be ready yet):', err)
        return []
      }
    },
    deleteContentByHash: (fileHash: string): void => {
      // 图像向量：先查 rowid，再删 vec0 行和映射
      const row = stmts.deleteImageVecByHash.get(fileHash) as { rowid: bigint | number } | undefined
      if (row) {
        stmts.deleteVecByRowid.run(Number(row.rowid))
        stmts.deleteVecMapByHash.run(fileHash)
      }
      // 人脸：face_vecs rowid 与 faces.id 一致，按 id 逐个清
      const faceRows = stmts.getFaceIdsByHash.all(fileHash) as Array<{ id: number }>
      for (const f of faceRows) {
        stmts.deleteFaceVec.run(f.id)
      }
      stmts.deleteFacesByHash.run(fileHash)
      // image_ocr_fts 通过触发器随 image_ocr 的 DELETE 自动清
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
    searchByFileName: (query, limit) => {
      const pattern = `%${query}%`
      const results = stmts.searchByFileName.all(pattern, pattern, limit) as Array<{ file_hash: string }>
      return results.map((r) => ({ fileHash: r.file_hash }))
    },
    searchByOcr: (query, limit) => {
      try {
        const ftsQuery = buildFtsQuery(query)
        if (!ftsQuery) return []
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

      // 写 vec0 索引。维度必须匹配 face_vecs schema。
      if (embedding.length === FACE_EMBEDDING_DIM) {
        try {
          // ON CONFLICT(file_hash, face_index) 的 UPDATE 路径会返回旧 id；
          // 因此 INSERT 失败时 fallback 到 UPDATE 保持 vec0 同步。
          stmts.insertFaceVec.run(result.id, embedding)
        } catch {
          try { stmts.updateFaceVec.run(embedding, result.id) } catch { /* ignore */ }
        }
      } else {
        console.warn(
          `face embedding dim mismatch (got ${embedding.length}, expected ${FACE_EMBEDDING_DIM}); skipping ANN index — search will fall back to BLOB scan`
        )
      }
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
    searchFaceKnn: (queryVec, k, excludeFaceId) => {
      try {
        // 多取一个，给排除自身留余地
        const fetchK = excludeFaceId != null ? k + 1 : k
        const rows = stmts.searchFaceKnnRaw.all(queryVec, fetchK) as Array<{
          faceId: bigint | number
          personId: number | null
          distance: number
        }>
        const out: Array<{ faceId: number; personId: number | null; distance: number }> = []
        for (const r of rows) {
          const id = Number(r.faceId)
          if (excludeFaceId != null && id === excludeFaceId) continue
          out.push({ faceId: id, personId: r.personId, distance: r.distance })
          if (out.length >= k) break
        }
        return out
      } catch (err) {
        console.warn('searchFaceKnn failed (vec0 may not be ready yet):', err)
        return []
      }
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

    // 视频
    addVideo: (folderId, filePath, fileName, fileSize, fileMtime, fileHash): number => {
      const result = stmts.addVideo.get(folderId, filePath, fileName, fileSize, fileMtime, fileHash) as { id: number }
      return result.id
    },
    getVideoById: (id) => {
      return stmts.getVideoById.get(id) as VideoRecord | undefined
    },
    getVideoByPath: (path) => {
      return stmts.getVideoByPath.get(path) as VideoRecord | undefined
    },
    updateVideoMeta: (id, data) => {
      stmts.updateVideoMeta.run(
        data.durationMs ?? null,
        data.width ?? null,
        data.height ?? null,
        data.frameCount ?? null,
        id,
      )
    },
    softDeleteVideo: (path) => {
      stmts.softDeleteVideo.run(path)
    },
    getFramePhotosByVideo: (videoId) => {
      return stmts.getFramePhotosByVideo.all(videoId) as Photo[]
    },
    removeFramesForVideo: (videoId): string[] => {
      const frames = stmts.getFramePhotosByVideo.all(videoId) as Photo[]
      if (frames.length === 0) return []
      const frameHashes = new Set(frames.map((f) => f.fileHash).filter((h): h is string => !!h))

      const tx = db.transaction(() => {
        for (const f of frames) stmts.softDeletePhoto.run(f.filePath)
      })
      tx()

      const orphaned: string[] = []
      const hasOther = db.prepare(
        `SELECT 1 FROM photos WHERE file_hash = ? AND deleted_at IS NULL LIMIT 1`
      )
      for (const hash of frameHashes) {
        if (!hasOther.get(hash)) {
          orphaned.push(hash)
          const vec = stmts.deleteImageVecByHash.get(hash) as { rowid: bigint | number } | undefined
          if (vec) {
            stmts.deleteVecByRowid.run(Number(vec.rowid))
            stmts.deleteVecMapByHash.run(hash)
          }
          const faceRows = stmts.getFaceIdsByHash.all(hash) as Array<{ id: number }>
          for (const fr of faceRows) stmts.deleteFaceVec.run(fr.id)
          stmts.deleteFacesByHash.run(hash)
          stmts.deleteCaptionByHash.run(hash)
          stmts.deleteOcrByHash.run(hash)
        }
      }
      return orphaned
    },
    cascadeRemoveVideo: (filePath) => {
      const video = stmts.getVideoByPath.get(filePath) as VideoRecord | undefined
      if (!video) return null

      // 找出所有帧 photos，逐张 soft-delete；记录它们的 hash 以便后续判孤立
      const frames = stmts.getFramePhotosByVideo.all(video.id) as Photo[]
      const frameHashes = new Set(frames.map((f) => f.fileHash).filter((h): h is string => !!h))

      const tx = db.transaction(() => {
        for (const f of frames) {
          stmts.softDeletePhoto.run(f.filePath)
        }
        stmts.softDeleteVideo.run(filePath)
      })
      tx()

      // 哪些 frame hash 已经没有任何存活 photos 引用 → 真正可以清内容
      const orphanedFrameHashes: string[] = []
      const hasOther = db.prepare(
        `SELECT 1 FROM photos WHERE file_hash = ? AND deleted_at IS NULL LIMIT 1`
      )
      for (const hash of frameHashes) {
        const row = hasOther.get(hash)
        if (!row) {
          orphanedFrameHashes.push(hash)
          // 复用 deleteContentByHash 的内联逻辑（同一段，避免实例自引用）
          const vec = stmts.deleteImageVecByHash.get(hash) as { rowid: bigint | number } | undefined
          if (vec) {
            stmts.deleteVecByRowid.run(Number(vec.rowid))
            stmts.deleteVecMapByHash.run(hash)
          }
          const faceRows = stmts.getFaceIdsByHash.all(hash) as Array<{ id: number }>
          for (const fr of faceRows) stmts.deleteFaceVec.run(fr.id)
          stmts.deleteFacesByHash.run(hash)
          stmts.deleteCaptionByHash.run(hash)
          stmts.deleteOcrByHash.run(hash)
        }
      }

      return { fileHash: video.fileHash || '', orphanedFrameHashes }
    },

    backupTo: async (destPath: string): Promise<void> => {
      // 复用 better-sqlite3 的 Online Backup（不阻塞读写、安全跨进程）
      await db.backup(destPath)
    },
    getMetaState: (key: string): string | undefined => {
      const row = db.prepare(`SELECT value FROM meta_state WHERE key = ?`).get(key) as
        | { value?: string }
        | undefined
      return row?.value
    },
    setMetaState: (key: string, value: string): void => {
      db.prepare(`INSERT OR REPLACE INTO meta_state(key, value) VALUES (?, ?)`).run(key, value)
    },

    close: (): void => { db.close() },
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
