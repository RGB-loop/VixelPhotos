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
  width?: number
  height?: number
  takenAt?: string
  lat?: number
  lng?: number
  caption?: string
  embedStatus: 'pending' | 'done' | 'error'
  captionStatus: 'pending' | 'done' | 'error'
  deletedAt?: string
  createdAt: string
  updatedAt: string
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
  indexedPhotos: number         // 已完成索引的照片数（有 embedding）
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
} as const

export interface ModelStatus {
  modelsDir: string
  modelExists: boolean
  mmprojExists: boolean
  llamaServerExists: boolean
  serverReady: boolean
}

export interface DownloadProgress {
  file: string
  downloaded: number
  total: number
  percent: number
  speed: number
}

export interface DownloadRequest {
  type: 'model' | 'mmproj' | 'llama-server'
}
