import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SearchResult, type WatchedFolder, type PhotoDetail, type PhotoLocation, type IndexProgress, type ModelStatus, type EmbeddingApiConfig, type Person, type FaceRecord, type BackupStatus } from '../shared/types'

const api = {
  // 搜索
  search: (query: string, limit?: number, options?: { dateFrom?: string; dateTo?: string }): Promise<SearchResult[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SEARCH, query, limit, options)
  },
  findSimilar: (photoId: number, limit?: number): Promise<SearchResult[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FIND_SIMILAR, photoId, limit)
  },
  getPhotosWithGPS: (): Promise<import('../shared/types').Photo[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTOS_WITH_GPS)
  },

  // 文件夹管理
  selectFolder: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER)
  },
  addFolder: (path: string): Promise<WatchedFolder> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ADD_FOLDER, path)
  },
  removeFolder: (id: number): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REMOVE_FOLDER, id)
  },
  getFolders: (): Promise<WatchedFolder[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_FOLDERS)
  },
  getFolderStats: (id: number): Promise<{ photoCount: number; photoIds: number[] }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_FOLDER_STATS, id)
  },

  // 照片
  getPhotoDetail: (id: number): Promise<PhotoDetail> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTO_DETAIL, id)
  },
  getThumbnail: (id: number): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_THUMBNAIL, id)
  },
  getThumbnailData: (id: number): Promise<string | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_THUMBNAIL_DATA, id)
  },
  getFullImageData: (id: number): Promise<string | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_FULL_IMAGE_DATA, id)
  },
  showInFinder: (filePath: string): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_IN_FINDER, filePath)
  },
  getPhotoLocations: (photoId: number): Promise<PhotoLocation[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTO_LOCATIONS, photoId)
  },

  // 进度
  onIndexProgress: (callback: (progress: IndexProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: IndexProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.INDEX_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.INDEX_PROGRESS, handler)
    }
  },

  // 系统 / 模型状态
  getAppPath: (): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_APP_PATH)
  },
  getModelStatus: (): Promise<ModelStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_MODEL_STATUS)
  },

  // Embedding provider 配置（onnx-local 默认 / api 高级）
  getEmbeddingConfig: (): Promise<EmbeddingApiConfig | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_EMBEDDING_CONFIG)
  },
  /**
   * config === null → 切回本地 ONNX
   * config 为对象 → 切到外部 API
   */
  setEmbeddingConfig: (config: EmbeddingApiConfig | null): Promise<{ success: boolean; ready?: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_EMBEDDING_CONFIG, config)
  },
  testEmbeddingApi: (): Promise<{ success: boolean; dimension?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TEST_EMBEDDING_API)
  },

  // Caption（手动编辑）
  updateCaption: (photoId: number, text: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CAPTION, photoId, text)
  },

  // OCR
  startOcrScan: (): Promise<{ queued?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.START_OCR_SCAN)
  },

  // 备份
  triggerBackup: (): Promise<{ success: boolean; path?: string; sizeBytes?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_BACKUP)
  },
  getBackupStatus: (): Promise<BackupStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_BACKUP_STATUS)
  },

  // 人脸识别
  startFaceScan: (): Promise<{ queued?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.START_FACE_SCAN)
  },
  getPeople: (): Promise<Person[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PEOPLE)
  },
  getPersonPhotos: (personId: number, limit?: number): Promise<SearchResult[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PERSON_PHOTOS, personId, limit)
  },
  setPersonName: (personId: number, name: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_PERSON_NAME, personId, name)
  },
  mergePeople: (targetId: number, sourceIds: number[]): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MERGE_PEOPLE, targetId, sourceIds)
  },
  getFaceThumbnail: (faceId: number): Promise<string | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_FACE_THUMBNAIL, faceId)
  },
  getPhotoFaces: (photoId: number): Promise<FaceRecord[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTO_FACES, photoId)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
