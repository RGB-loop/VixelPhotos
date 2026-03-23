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
  captionStatus: 'pending' | 'done' | 'error'
  duplicateCount?: number
  deletedAt?: string
  createdAt: string
  updatedAt: string
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
  captionedPhotos: number       // 已生成 AI 描述的照片数

  // 当前状态
  stage: 'idle' | 'indexing' | 'captioning'
  currentFile?: string

  // AI 模型状态
  aiModelReady: boolean
}

export interface PhotoDetail extends Photo {
  exif?: ExifData
  caption?: string
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

  // 下载管理
  DOWNLOAD_MODEL: 'download-model',
  DOWNLOAD_LLAMA_SERVER: 'download-llama-server',
  CANCEL_DOWNLOAD: 'cancel-download',
  DOWNLOAD_PROGRESS: 'download-progress',
  INIT_CAPTION_GENERATOR: 'init-caption-generator',

  // Embedding API 配置
  GET_EMBEDDING_CONFIG: 'get-embedding-config',
  SET_EMBEDDING_CONFIG: 'set-embedding-config',
  TEST_EMBEDDING_API: 'test-embedding-api',

  // Caption 配置与操作
  GET_CAPTION_CONFIG: 'get-caption-config',
  SET_CAPTION_CONFIG: 'set-caption-config',
  REGENERATE_CAPTION: 'regenerate-caption',
  UPDATE_CAPTION: 'update-caption',

  // 相似照片
  FIND_SIMILAR: 'find-similar',

  // 地图
  GET_PHOTOS_WITH_GPS: 'get-photos-with-gps',
} as const

export interface ModelStatus {
  modelsDir: string
  // Caption 模型 (Qwen3.5-4B)
  captionModelExists: boolean
  captionMmprojExists: boolean
  captionReady: boolean
  // Embedding API（使用外部 API，不使用本地模型）
  embeddingApiConfigured: boolean
  embeddingApiEndpoint?: string
  embeddingReady: boolean
  // llama-server
  llamaServerExists: boolean
  serverReady: boolean
  currentModel: 'caption' | null  // embedding 不再使用本地 llama-server
}

export interface EmbeddingApiConfig {
  endpoint: string
  apiKey?: string
  model?: string
}

export type CaptionLanguage = 'en' | 'zh'

export interface CaptionConfig {
  language: CaptionLanguage
}

export interface DownloadProgress {
  file: string
  downloaded: number
  total: number
  percent: number
  speed: number
}

export type ModelDownloadType = 'caption' | 'captionMmproj' | 'embedding' | 'embeddingMmproj'
