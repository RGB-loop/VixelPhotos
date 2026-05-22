import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from '../core/db'
import { FileWatcher } from '../core/watcher'
import { Indexer } from '../core/indexer'
import { SearchEngine } from '../core/search'
import { getEmbeddingService, initEmbeddingServicePath } from '../core/embedding'
import { setFaceModelsDir, getFaceThumbnail } from '../core/face'
import { setOcrModelsDir } from '../core/ocr'
import { IPC_CHANNELS, type IndexProgress, type FaceBbox } from '../shared/types'

// 全局服务实例
let db: ReturnType<typeof initDatabase>
let watcher: FileWatcher
let indexer: Indexer
let searchEngine: SearchEngine
let mainWindow: BrowserWindow | null = null
let bundledModelsDir: string = ''

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function initServices(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'library.db')

  console.log('Initializing Vixel services...')

  // 模型目录：生产用 extraResources，开发用 resources/models
  const prodModelsDir = join(process.resourcesPath, 'models')
  const devModelsDir = join(process.cwd(), 'resources', 'models')
  bundledModelsDir = existsSync(prodModelsDir) ? prodModelsDir : devModelsDir

  initEmbeddingServicePath(userDataPath, bundledModelsDir)
  setFaceModelsDir(bundledModelsDir)
  setOcrModelsDir(bundledModelsDir)

  db = initDatabase(dbPath)
  db.recoverStuckTasks()
  db.requeueMissingEmbeddings()

  indexer = new Indexer(db, userDataPath)
  indexer.on('progress', (progress: IndexProgress) => {
    mainWindow?.webContents.send(IPC_CHANNELS.INDEX_PROGRESS, progress)
  })

  watcher = new FileWatcher(db, indexer)
  searchEngine = new SearchEngine(db)

  const folders = db.getFolders()
  for (const folder of folders) {
    watcher.watchFolder(folder.id, folder.path)
  }

  // 后台预加载 SigLIP 2（首次推理可能 2-5s 慢启动）
  setTimeout(() => {
    indexer.preloadModels().catch(() => {})
  }, 2000)
}

function registerIpcHandlers(): void {
  // 搜索
  ipcMain.handle(IPC_CHANNELS.SEARCH, async (_event, query: string, limit?: number, options?: { dateFrom?: string; dateTo?: string }) => {
    return searchEngine.search(query, limit, options)
  })

  ipcMain.handle(IPC_CHANNELS.GET_PHOTOS_WITH_GPS, async () => {
    return db.getPhotosWithGPS()
  })

  ipcMain.handle(IPC_CHANNELS.FIND_SIMILAR, async (_event, photoId: number, limit?: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return []
    return searchEngine.findSimilar(photo.fileHash, limit || 12)
  })

  ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.ADD_FOLDER, async (_event, folderPath: string) => {
    const folder = db.addFolder(folderPath)
    watcher.watchFolder(folder.id, folder.path)
    return folder
  })

  ipcMain.handle(IPC_CHANNELS.REMOVE_FOLDER, async (_event, folderId: number) => {
    const folder = db.getFolder(folderId)
    if (folder) {
      watcher.unwatchFolder(folderId)
      const orphanedHashes = db.deletePhotosByFolder(folderId)
      const thumbnailsDir = join(app.getPath('userData'), 'thumbnails')
      for (const hash of orphanedHashes) {
        const thumbnailPath = join(thumbnailsDir, `${hash}.webp`)
        try {
          if (existsSync(thumbnailPath)) {
            await unlink(thumbnailPath)
          }
        } catch (e) {
          console.warn(`Failed to delete thumbnail: ${thumbnailPath}`, e)
        }
      }
      db.removeFolder(folderId)
    }
    return true
  })

  ipcMain.handle(IPC_CHANNELS.GET_FOLDERS, async () => {
    return db.getFoldersWithStats()
  })

  ipcMain.handle(IPC_CHANNELS.GET_FOLDER_STATS, async (_event, folderId: number) => {
    return db.getFolderStats(folderId)
  })

  ipcMain.handle(IPC_CHANNELS.GET_PHOTO_DETAIL, async (_event, photoId: number) => {
    return db.getPhotoDetail(photoId)
  })

  ipcMain.handle(IPC_CHANNELS.GET_THUMBNAIL, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return null
    return indexer.getThumbnailPath(photo.fileHash)
  })

  ipcMain.handle(IPC_CHANNELS.GET_THUMBNAIL_DATA, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return null
    try {
      const thumbnailPath = indexer.getThumbnailPath(photo.fileHash)
      const buffer = await readFile(thumbnailPath)
      return `data:image/webp;base64,${buffer.toString('base64')}`
    } catch { return null }
  })

  ipcMain.handle(IPC_CHANNELS.GET_PHOTO_LOCATIONS, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return []
    return db.getPhotoLocations(photo.fileHash)
  })

  ipcMain.handle(IPC_CHANNELS.GET_FULL_IMAGE_DATA, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo || !photo.filePath || !existsSync(photo.filePath)) {
      return null
    }
    const buffer = await readFile(photo.filePath)
    const ext = photo.filePath.split('.').pop()?.toLowerCase() || 'jpeg'
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  })

  ipcMain.handle(IPC_CHANNELS.SHOW_IN_FINDER, async (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.GET_APP_PATH, async () => {
    return app.getPath('userData')
  })

  // 模型状态（v0.2：SigLIP 2 本地模型 + 可选 API 兜底）
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_STATUS, async () => {
    const embeddingService = getEmbeddingService()
    const config = embeddingService.getConfig()
    const siglipDir = join(bundledModelsDir, 'siglip2')
    const localModelExists = existsSync(siglipDir)

    return {
      modelsDir: bundledModelsDir,
      providerType: config.type, // 'onnx-local' | 'api'
      localModelExists,
      embeddingReady: embeddingService.isReady(),
      apiConfigured: config.type === 'api' && !!config.endpoint,
      apiEndpoint: config.type === 'api' ? config.endpoint : undefined,
      initError: embeddingService.getInitError(),
    }
  })

  // Embedding 配置：切到 API 后端（高级选项）
  ipcMain.handle(IPC_CHANNELS.GET_EMBEDDING_CONFIG, async () => {
    const config = getEmbeddingService().getConfig()
    if (config.type === 'api') {
      return { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model }
    }
    return null
  })

  ipcMain.handle(
    IPC_CHANNELS.SET_EMBEDDING_CONFIG,
    async (_event, config: { endpoint: string; apiKey?: string; model?: string } | null) => {
      try {
        const svc = getEmbeddingService()
        if (config === null) {
          svc.useLocal()
        } else {
          svc.setApiConfig(config)
        }
        await svc.init()
        return { success: true, ready: svc.isReady() }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.TEST_EMBEDDING_API, async () => {
    try {
      const svc = getEmbeddingService()
      if (!svc.isConfigured()) {
        return { success: false, error: 'Provider not configured' }
      }
      const testVec = await svc.encodeText('test')
      return { success: true, dimension: testVec.length }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 手动更新 caption（用户编辑）
  ipcMain.handle(IPC_CHANNELS.UPDATE_CAPTION, async (_event, photoId: number, text: string) => {
    try {
      const photo = db.getPhoto(photoId)
      if (!photo?.fileHash) return { success: false, error: 'Photo not found' }
      db.saveCaption(photo.fileHash, text)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 人脸识别
  ipcMain.handle(IPC_CHANNELS.START_FACE_SCAN, async () => {
    try {
      return await indexer.startFaceScan()
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // OCR 扫描
  ipcMain.handle(IPC_CHANNELS.START_OCR_SCAN, async () => {
    try {
      return await indexer.startOcrScan()
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.GET_PEOPLE, async () => {
    return db.getPeople()
  })

  ipcMain.handle(IPC_CHANNELS.GET_PERSON_PHOTOS, async (_event, personId: number, limit?: number) => {
    const photos = db.getPersonPhotos(personId, limit || 50)
    return photos.map((p) => ({ photo: p, score: 1.0 }))
  })

  ipcMain.handle(IPC_CHANNELS.SET_PERSON_NAME, async (_event, personId: number, name: string) => {
    db.updatePersonName(personId, name)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.MERGE_PEOPLE, async (_event, targetId: number, sourceIds: number[]) => {
    db.mergePeople(targetId, sourceIds)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.GET_FACE_THUMBNAIL, async (_event, faceId: number) => {
    try {
      const info = db.getFaceCoverInfo(faceId)
      if (!info) return null
      const photo = db.getRepresentativeByHash(info.fileHash)
      if (!photo) return null
      const imageBuffer = await readFile(photo.filePath)
      const bbox = JSON.parse(info.bbox) as FaceBbox
      const crop = await getFaceThumbnail(imageBuffer, bbox)
      return `data:image/jpeg;base64,${crop.toString('base64')}`
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.GET_PHOTO_FACES, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return []
    return db.getFacesByHash(photo.fileHash)
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.vixel.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await initServices()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  watcher?.stopAll()
  db?.close()
})
