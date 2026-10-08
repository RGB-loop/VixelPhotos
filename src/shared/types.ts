// ============================================
// Shared Types - 主进程和渲染进程共用的类型定义
// ============================================

export interface Photo {
  id: number
  folderId: number
  filePath: string
  fileName: string
  fileSize: number
  fileMtime: number
  fileHash: string
  width?: number
  height?: number
  takenAt?: string
  lat?: number
  lng?: number
  caption?: string
  embedStatus: 'pending' | 'done' | 'error'
  faceStatus?: 'pending' | 'done' | 'error'
  faceCount?: number
  duplicateCount?: number
  /** 若是视频抽出的帧：来源视频在 videos 表里的 id */
  videoId?: number | null
  /** 若是视频抽出的帧：该帧对应的视频时间戳（毫秒） */
  frameTimeMs?: number | null
  deletedAt?: string
  createdAt: string
  updatedAt: string
}

export interface VideoRecord {
  id: number
  folderId: number
  filePath: string
  fileName: string
  fileSize: number
  fileMtime: number
  fileHash: string
  durationMs?: number
  width?: number
  height?: number
  frameCount?: number
  deletedAt?: string
  createdAt: string
}

export interface PhotoLocation {
  filePath: string
  folderPath: string
  folderName: string
  folderId: number
}

export interface WatchedFolder {
  id: number
  path: string
  lastScanAt?: string
  recursive: boolean
  createdAt: string
  photoCount?: number // 该文件夹中的照片数量
}

export interface SearchResult {
  photo: Photo
  score: number
  thumbnailPath?: string
}

export interface IndexProgress {
  // 照片统计（基于实际照片数，不是任务数）
  totalPhotos: number           // 总照片数
  thumbnailedPhotos: number     // 已生成缩略图的照片数
  indexedPhotos: number         // 已完成 embedding 的照片数

  // 当前状态
  stage: 'idle' | 'indexing' | 'ocr' | 'detecting_faces'
  currentFile?: string
  // OCR 进度
  ocrPhotos?: number

  // AI 模型状态
  aiModelReady: boolean
}

export interface PhotoDetail extends Photo {
  exif?: ExifData
  caption?: string
  /** PaddleOCR 识别出的图内文字（多行用 \n 分隔），无则不设 */
  ocrText?: string
}

export interface ExifData {
  make?: string
  model?: string
  exposureTime?: string
  fNumber?: number
  iso?: number
  focalLength?: number
  dateTime?: string
  gps?: {
    latitude: number
    longitude: number
  }
}

// IPC 通道名称常量
export const IPC_CHANNELS = {
  // 搜索
  SEARCH: 'search',

  // 文件夹管理
  ADD_FOLDER: 'add-folder',
  REMOVE_FOLDER: 'remove-folder',
  GET_FOLDERS: 'get-folders',
  SELECT_FOLDER: 'select-folder',
  GET_FOLDER_STATS: 'get-folder-stats',

  // 照片
  GET_PHOTO_DETAIL: 'get-photo-detail',
  GET_THUMBNAIL: 'get-thumbnail',
  GET_THUMBNAIL_DATA: 'get-thumbnail-data',
  GET_FULL_IMAGE_DATA: 'get-full-image-data',
  SHOW_IN_FINDER: 'show-in-finder',
  GET_PHOTO_LOCATIONS: 'get-photo-locations',

  // 进度
  INDEX_PROGRESS: 'index-progress',

  // 系统
  GET_APP_PATH: 'get-app-path',
  GET_MODEL_STATUS: 'get-model-status',

  // Embedding（EmbeddingGemma 2，纯本地；可调量化档位）
  GET_EMBEDDING_CONFIG: 'get-embedding-config',
  SET_EMBEDDING_CONFIG: 'set-embedding-config',

  // Caption（v0.2：仅手动编辑，无自动生成）
  UPDATE_CAPTION: 'update-caption',

  // 相似照片
  FIND_SIMILAR: 'find-similar',

  // 地图
  GET_PHOTOS_WITH_GPS: 'get-photos-with-gps',

  // OCR
  START_OCR_SCAN: 'start-ocr-scan',

  // 视频源文件
  OPEN_SOURCE_VIDEO: 'open-source-video',

  // 备份
  TRIGGER_BACKUP: 'trigger-backup',
  GET_BACKUP_STATUS: 'get-backup-status',

  // 人脸识别
  START_FACE_SCAN: 'start-face-scan',
  GET_PEOPLE: 'get-people',
  GET_PERSON_PHOTOS: 'get-person-photos',
  SET_PERSON_NAME: 'set-person-name',
  MERGE_PEOPLE: 'merge-people',
  GET_FACE_THUMBNAIL: 'get-face-thumbnail',
  GET_PHOTO_FACES: 'get-photo-faces',
} as const

export interface ModelStatus {
  modelsDir: string
  providerType: 'gemma2-local'
  localModelExists: boolean   // resources/models/gemma2/ 是否存在
  embeddingReady: boolean
  textQuantization?: 'q4' | 'q8'
  visionQuantization?: 'q4' | 'q8'
  audioQuantization?: 'q4' | 'q8'
  initError: string | null
}

export interface EmbeddingQuantizationConfig {
  textQuantization?: 'q4' | 'q8'
  visionQuantization?: 'q4' | 'q8'
  audioQuantization?: 'q4' | 'q8'
  device?: 'cpu' | 'webgpu'
}

// Embedding provider 选项（renderer 用来切换 UI 状态）
export type EmbeddingProviderType = 'gemma2-local'

export interface BackupStatus {
  lastBackupAt: number | null    // epoch ms
  intervalMs: number             // 自动备份周期
  keepCount: number              // 滚动保留份数
  currentCount: number           // 当前磁盘上的备份数量
  inProgress: boolean
  backupsDir: string
}

// 人脸检测
export interface FaceBbox {
  x: number  // 归一化 0-1
  y: number
  w: number
  h: number
}

export interface FaceRecord {
  id: number
  fileHash: string
  faceIndex: number
  bbox: FaceBbox
  confidence: number
  personId: number | null
  personName?: string | null
}

export interface Person {
  id: number
  name: string | null
  coverFaceId: number | null
  faceCount: number
  photoCount?: number
  createdAt: string
}

export type ProcessingStatus = 'pending' | 'done' | 'error'
export type TaskType = 'thumbnail' | 'embed' | 'face' | 'ocr' | 'extract_frames'
