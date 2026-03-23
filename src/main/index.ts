import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from './db'
import { FileWatcher } from './services/watcher'
import { Indexer } from './services/indexer'
import { SearchEngine } from './services/search'
import { getDownloadManager, MODEL_FILES } from './services/downloadManager'
import { getLlamaServerManager } from './services/llama/serverManager'
import { getEmbeddingService } from './services/embedding'
import { IPC_CHANNELS, type WatchedFolder, type IndexProgress, type DownloadProgress } from '../shared/types'

// 全局服务实例
let db: ReturnType<typeof initDatabase>
let watcher: FileWatcher
let indexer: Indexer
let searchEngine: SearchEngine
let mainWindow: BrowserWindow | null = null

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

  // 开发环境加载 dev server，生产环境加载打包文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 初始化服务
async function initServices(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'library.db')

  console.log('Initializing database at:', dbPath)
  console.log('User data path:', userDataPath)

  // 初始化数据库
  db = initDatabase(dbPath)

  // 恢复上次运行时卡住的任务（程序被强制关闭时可能发生）
  const recoveredTasks = db.recoverStuckTasks()
  if (recoveredTasks > 0) {
    console.log(`Recovered ${recoveredTasks} stuck tasks from previous run`)
  }

  // 重新队列缺失 embedding 的照片（模型之前不可用时可能发生）
  const requeuedEmbeddings = db.requeueMissingEmbeddings()
  if (requeuedEmbeddings > 0) {
    console.log(`Requeued ${requeuedEmbeddings} photos for embedding`)
  }

  // 初始化索引器
  indexer = new Indexer(db, userDataPath)

  // 监听索引进度
  indexer.on('progress', (progress: IndexProgress) => {
    mainWindow?.webContents.send(IPC_CHANNELS.INDEX_PROGRESS, progress)
  })

  // 初始化文件监听器
  watcher = new FileWatcher(db, indexer)

  // 初始化搜索引擎
  searchEngine = new SearchEngine(db)

  // 恢复监控已有的文件夹
  const folders = db.getFolders()
  for (const folder of folders) {
    watcher.watchFolder(folder.id, folder.path)
  }

  console.log('Services initialized')

  // 初始化 llama server manager（配置模型路径）
  const llamaManager = getLlamaServerManager(userDataPath)
  const modelsDir = join(userDataPath, 'models')

  // 配置 embedding 模型
  llamaManager.setModelConfig('embedding', {
    type: 'embedding',
    modelPath: join(modelsDir, 'Qwen3-VL-Embedding-2B-Q4_K_M.gguf'),
    mmprojPath: join(modelsDir, 'mmproj-Qwen3-VL-Embedding-2B.gguf'),
    embeddingMode: true,
    poolingType: 'last',
    contextSize: 8192,
  })

  // 配置 caption 模型 (Qwen3.5-4B 多模态，原生支持 262K context)
  llamaManager.setModelConfig('caption', {
    type: 'caption',
    modelPath: join(modelsDir, 'Qwen3.5-4B-Q4_K_M.gguf'),
    mmprojPath: join(modelsDir, 'mmproj-Qwen3.5-4B-F16.gguf'),
    contextSize: 32768,
  })

  // 后台预加载 embedding 模型（用于搜索）
  setTimeout(() => {
    console.log('Starting embedding model preload...')
    indexer.preloadModels().catch((e) => {
      console.error('Model preload error:', e)
    })
  }, 2000)
}

// 注册 IPC 处理器
function registerIpcHandlers(): void {
  // 搜索
  ipcMain.handle(IPC_CHANNELS.SEARCH, async (_event, query: string, limit?: number) => {
    return searchEngine.search(query, limit)
  })

  // 选择文件夹对话框
  ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  // 添加监控文件夹
  ipcMain.handle(IPC_CHANNELS.ADD_FOLDER, async (_event, folderPath: string) => {
    const folder = db.addFolder(folderPath)
    watcher.watchFolder(folder.id, folder.path)
    return folder
  })

  // 移除监控文件夹（包括删除所有索引数据）
  ipcMain.handle(IPC_CHANNELS.REMOVE_FOLDER, async (_event, folderId: number) => {
    const folder = db.getFolder(folderId)
    if (folder) {
      // 1. 停止监听
      watcher.unwatchFolder(folderId)

      // 2. 删除照片数据，返回孤立的 hash（没有其他文件夹有副本）
      const orphanedHashes = db.deletePhotosByFolder(folderId)

      // 3. 删除孤立 hash 的缩略图文件
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

      // 4. 删除文件夹记录
      db.removeFolder(folderId)

      console.log(`Removed folder ${folderId}, cleaned ${orphanedHashes.length} orphaned hashes`)
    }
    return true
  })

  // 获取所有监控文件夹（包含照片数量统计）
  ipcMain.handle(IPC_CHANNELS.GET_FOLDERS, async () => {
    return db.getFoldersWithStats()
  })

  // 获取文件夹统计信息
  ipcMain.handle(IPC_CHANNELS.GET_FOLDER_STATS, async (_event, folderId: number) => {
    return db.getFolderStats(folderId)
  })

  // 获取照片详情
  ipcMain.handle(IPC_CHANNELS.GET_PHOTO_DETAIL, async (_event, photoId: number) => {
    return db.getPhotoDetail(photoId)
  })

  // 获取缩略图路径（按 hash）
  ipcMain.handle(IPC_CHANNELS.GET_THUMBNAIL, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return null
    return indexer.getThumbnailPath(photo.fileHash)
  })

  // 获取缩略图数据（base64，按 hash）
  ipcMain.handle(IPC_CHANNELS.GET_THUMBNAIL_DATA, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return null
    const thumbnailPath = indexer.getThumbnailPath(photo.fileHash)
    if (!existsSync(thumbnailPath)) return null
    const buffer = await readFile(thumbnailPath)
    return `data:image/webp;base64,${buffer.toString('base64')}`
  })

  // 获取照片所有位置（按 hash 查重复）
  ipcMain.handle(IPC_CHANNELS.GET_PHOTO_LOCATIONS, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return []
    return db.getPhotoLocations(photo.fileHash)
  })

  // 获取原图数据（base64）
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

  // 在 Finder 中显示
  ipcMain.handle(IPC_CHANNELS.SHOW_IN_FINDER, async (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
    return true
  })

  // 获取应用路径
  ipcMain.handle(IPC_CHANNELS.GET_APP_PATH, async () => {
    return app.getPath('userData')
  })

  // 获取模型状态
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_STATUS, async () => {
    const downloadManager = getDownloadManager()
    const modelsDir = downloadManager.getModelsDir()

    // 检查 Caption 模型文件是否存在
    const captionModelExists = existsSync(join(modelsDir, MODEL_FILES.caption.name))
    const captionMmprojExists = existsSync(join(modelsDir, MODEL_FILES.captionMmproj.name))

    const llamaManager = getLlamaServerManager()
    const embeddingService = getEmbeddingService()
    const embeddingConfig = embeddingService.getConfig()

    return {
      modelsDir,
      // Caption 模型状态
      captionModelExists,
      captionMmprojExists,
      captionReady: captionModelExists && captionMmprojExists,
      // Embedding API 状态（使用外部 API，不使用本地模型）
      embeddingApiConfigured: embeddingService.isConfigured(),
      embeddingApiEndpoint: embeddingConfig?.endpoint,
      embeddingReady: embeddingService.isReady(),
      // llama-server
      llamaServerExists: downloadManager.isLlamaServerInstalled(),
      serverReady: llamaManager.isServerReady(),
      currentModel: llamaManager.getCurrentModel() === 'caption' ? 'caption' : null,
    }
  })

  // 下载模型
  ipcMain.handle(
    IPC_CHANNELS.DOWNLOAD_MODEL,
    async (_event, type: 'caption' | 'captionMmproj' | 'embedding' | 'embeddingMmproj') => {
      const downloadManager = getDownloadManager()
      const progressCallback = (progress: DownloadProgress): void => {
        mainWindow?.webContents.send(IPC_CHANNELS.DOWNLOAD_PROGRESS, progress)
      }

      try {
        await downloadManager.downloadModel(type, progressCallback)
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  // 下载 llama-server
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_LLAMA_SERVER, async () => {
    const downloadManager = getDownloadManager()
    const progressCallback = (progress: DownloadProgress): void => {
      mainWindow?.webContents.send(IPC_CHANNELS.DOWNLOAD_PROGRESS, progress)
    }

    try {
      await downloadManager.installLlamaServer(progressCallback)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 取消下载
  ipcMain.handle(IPC_CHANNELS.CANCEL_DOWNLOAD, async (_event, fileName: string) => {
    const downloadManager = getDownloadManager()
    downloadManager.cancelDownload(fileName)
    return { success: true }
  })

  // 初始化 Caption 模型（Qwen3.5-4B）
  ipcMain.handle(IPC_CHANNELS.INIT_CAPTION_GENERATOR, async () => {
    try {
      const llamaManager = getLlamaServerManager()
      await llamaManager.ensureModel('caption')
      return { success: true, ready: llamaManager.isModelLoaded('caption') }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 获取 Embedding API 配置
  ipcMain.handle(IPC_CHANNELS.GET_EMBEDDING_CONFIG, async () => {
    const embeddingService = getEmbeddingService()
    const config = embeddingService.getConfig()
    return config ? { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model } : null
  })

  // 设置 Embedding API 配置
  ipcMain.handle(
    IPC_CHANNELS.SET_EMBEDDING_CONFIG,
    async (_event, config: { endpoint: string; apiKey?: string; model?: string }) => {
      try {
        const embeddingService = getEmbeddingService()
        embeddingService.setConfig(config)
        await embeddingService.init()
        return { success: true, ready: embeddingService.isReady() }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  // 测试 Embedding API
  ipcMain.handle(IPC_CHANNELS.TEST_EMBEDDING_API, async () => {
    try {
      const embeddingService = getEmbeddingService()
      if (!embeddingService.isConfigured()) {
        return { success: false, error: 'API not configured' }
      }
      // 尝试编码一个简单文本
      const testVec = await embeddingService.encodeText('test')
      return { success: true, dimension: testVec.length }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

// 应用启动
app.whenReady().then(async () => {
  // 设置应用 ID (macOS)
  electronApp.setAppUserModelId('com.vixel.app')

  // 开发环境优化
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

// 退出处理
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 清理资源
  watcher?.stopAll()
  getLlamaServerManager().stop()
  db?.close()
})
