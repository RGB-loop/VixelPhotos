import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SearchResult, type WatchedFolder, type PhotoDetail, type PhotoLocation, type IndexProgress, type ModelStatus, type DownloadProgress, type EmbeddingApiConfig, type CaptionConfig } from '../shared/types'

// 暴露给渲染进程的 API
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

  // 进度监听
  onIndexProgress: (callback: (progress: IndexProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: IndexProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.INDEX_PROGRESS, handler)

    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.INDEX_PROGRESS, handler)
    }
  },

  // 系统
  getAppPath: (): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_APP_PATH)
  },
  getModelStatus: (): Promise<ModelStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_MODEL_STATUS)
  },

  // 下载管理
  downloadModel: (type: 'model' | 'mmproj'): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_MODEL, type)
  },
  downloadLlamaServer: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_LLAMA_SERVER)
  },
  cancelDownload: (fileName: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CANCEL_DOWNLOAD, fileName)
  },
  onDownloadProgress: (callback: (progress: DownloadProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: DownloadProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.DOWNLOAD_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DOWNLOAD_PROGRESS, handler)
    }
  },
  initCaptionGenerator: (): Promise<{ success: boolean; ready?: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INIT_CAPTION_GENERATOR)
  },

  // Embedding API 配置
  getEmbeddingConfig: (): Promise<EmbeddingApiConfig | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_EMBEDDING_CONFIG)
  },
  setEmbeddingConfig: (config: EmbeddingApiConfig): Promise<{ success: boolean; ready?: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_EMBEDDING_CONFIG, config)
  },
  testEmbeddingApi: (): Promise<{ success: boolean; dimension?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TEST_EMBEDDING_API)
  },

  // Caption 配置与操作
  getCaptionConfig: (): Promise<CaptionConfig> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_CAPTION_CONFIG)
  },
  setCaptionConfig: (config: CaptionConfig): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_CAPTION_CONFIG, config)
  },
  regenerateCaption: (photoId: number): Promise<{ success: boolean; caption?: string; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REGENERATE_CAPTION, photoId)
  },
  updateCaption: (photoId: number, text: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CAPTION, photoId, text)
  },
}

// 将 API 暴露到 window 对象
contextBridge.exposeInMainWorld('api', api)

// 类型声明
export type Api = typeof api
