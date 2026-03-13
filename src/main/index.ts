import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from './db'
import { FileWatcher } from './services/watcher'
import { Indexer } from './services/indexer'
import { SearchEngine } from './services/search'
import { getLlamaServer } from './services/llamaServer'
import { getDownloadManager, MODEL_FILES } from './services/downloadManager'
import { getCaptionGenerator } from './services/captionGenerator'
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

  // 后台预加载 AI 模型（不阻塞启动）
  setTimeout(() => {
    console.log('Starting AI model preload...')
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

  // 移除监控文件夹
  ipcMain.handle(IPC_CHANNELS.REMOVE_FOLDER, async (_event, folderId: number) => {
    const folder = db.getFolder(folderId)
    if (folder) {
      watcher.unwatchFolder(folderId)
      db.removeFolder(folderId)
    }
    return true
  })

  // 获取所有监控文件夹
  ipcMain.handle(IPC_CHANNELS.GET_FOLDERS, async () => {
    return db.getFolders()
  })

  // 获取照片详情
  ipcMain.handle(IPC_CHANNELS.GET_PHOTO_DETAIL, async (_event, photoId: number) => {
    return db.getPhotoDetail(photoId)
  })

  // 获取缩略图路径
  ipcMain.handle(IPC_CHANNELS.GET_THUMBNAIL, async (_event, photoId: number) => {
    const thumbnailPath = join(app.getPath('userData'), 'thumbnails', `${photoId}.webp`)
    return thumbnailPath
  })

  // 获取缩略图数据（base64）
  ipcMain.handle(IPC_CHANNELS.GET_THUMBNAIL_DATA, async (_event, photoId: number) => {
    const thumbnailPath = join(app.getPath('userData'), 'thumbnails', `${photoId}.webp`)
    if (!existsSync(thumbnailPath)) {
      return null
    }
    const buffer = await readFile(thumbnailPath)
    return `data:image/webp;base64,${buffer.toString('base64')}`
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
    const server = getLlamaServer()
    const downloadManager = getDownloadManager()
    const models = server.checkModels()
    return {
      modelsDir: server.getModelsDir(),
      modelExists: models.model,
      mmprojExists: models.mmproj,
      llamaServerExists: downloadManager.isLlamaServerInstalled(),
      serverReady: server.isServerReady(),
    }
  })

  // 下载模型
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_MODEL, async (_event, type: 'model' | 'mmproj') => {
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
  })

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

  // 初始化/重新初始化 caption generator
  ipcMain.handle(IPC_CHANNELS.INIT_CAPTION_GENERATOR, async () => {
    try {
      const captionGen = getCaptionGenerator()
      // 强制重新初始化
      await captionGen.reinit()
      return { success: true, ready: captionGen.isAvailable() }
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
  getLlamaServer().stop()
  db?.close()
})
