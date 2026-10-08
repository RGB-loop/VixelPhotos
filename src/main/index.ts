import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net, nativeTheme } from 'electron'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { readFile, unlink, mkdir, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from '../core/db'
import { FileWatcher } from '../core/watcher'
import { Indexer } from '../core/indexer'
import { SearchEngine, type SearchOptions } from '../core/search'
import { getEmbeddingService, initEmbeddingServicePath } from '../core/embedding'
import { setFaceModelsDir, getFaceThumbnail } from '../core/face'
import { setOcrModelsDir } from '../core/ocr'
import { preloadJieba } from '../core/text/tokenize'
import { formatBackupName, selectExpired } from '../core/backup'
import { serveMediaFile } from '../core/media/serve'
import { installAppMenu, popupItemMenu } from './menu'
import { IPC_CHANNELS, type ThemeMode, type IndexProgress, type FaceBbox, type EmbeddingQuantizationConfig } from '../shared/types'

// 备份配置：每 24h 一次，保留最近 3 份；可后续从 settings 暴露
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const BACKUP_KEEP_COUNT = 3
const META_KEY_LAST_BACKUP = 'last_backup_at'
const META_KEY_THEME = 'ui.theme'
let backupTimer: NodeJS.Timeout | null = null
let backupInFlight = false

// 全局服务实例
let db: ReturnType<typeof initDatabase>
let watcher: FileWatcher
let indexer: Indexer
let searchEngine: SearchEngine
let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let bundledModelsDir: string = ''

/** 窗口底色：首帧渲染前露出来的颜色，要和当前外观的内容区一致，否则切换 / 打开时闪一下 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0f0f0f' : '#ffffff'
}

/**
 * 外观由 nativeTheme.themeSource 统一控制：它决定所有窗口的 prefers-color-scheme，
 * 渲染进程的 CSS 变量随之切换，原生菜单 / 滚动条 / 对话框也一起跟着变。
 */
function applyTheme(mode: ThemeMode): void {
  nativeTheme.themeSource = mode
}

function loadTheme(): ThemeMode {
  const v = db.getMetaState(META_KEY_THEME)
  return v === 'light' || v === 'dark' ? v : 'system'
}

const WEB_PREFERENCES: Electron.WebPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  sandbox: false,
  contextIsolation: true,
  nodeIntegration: false,
}

/** 主窗口和设置窗口共用一个渲染入口，按 hash 区分（main.tsx 里路由） */
function loadRenderer(win: BrowserWindow, hash?: string): void {
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? `#${hash}` : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    backgroundColor: windowBackground(),
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    // 红绿灯垂直居中在 52px 工具栏 / 侧边栏顶部
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: WEB_PREFERENCES,
  })
  mainWindow = win
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  loadRenderer(win)
}

/** 设置窗口（⌘,）：独立窗口、单例，再次打开只是拉到前面 */
function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  const win = new BrowserWindow({
    backgroundColor: windowBackground(),
    width: 640,
    height: 600,
    minWidth: 560,
    minHeight: 440,
    show: false,
    title: '设置',
    fullscreenable: false,
    minimizable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: WEB_PREFERENCES,
  })
  settingsWindow = win
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => { if (settingsWindow === win) settingsWindow = null })
  loadRenderer(win, 'settings')
}

/** 文件夹增删后通知所有窗口：主窗口刷新侧边栏 / 网格，设置窗口刷新列表 */
function broadcastLibraryChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC_CHANNELS.LIBRARY_CHANGED)
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
  db.pruneDoneTasks()
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

  // 后台预加载：
  //   - jieba 首次切词约 150 ms，提前热掉避免第一次写入/搜索阻塞 SQLite 触发器
  //   - EmbeddingGemma 2 首次加载较慢，预拉模型权重到内存
  // 都是 fire-and-forget，失败不阻塞应用。
  preloadJieba().catch(() => {})
  setTimeout(() => {
    indexer.preloadModels().catch(() => {})
  }, 2000)

  // 启动备份调度器
  scheduleBackups()
}

/**
 * 备份调度：启动时检查上次备份距今 ≥ 24h 就立刻跑一次，
 * 之后每 24h 周期触发。重启不丢节奏 —— last_backup_at 在 meta_state。
 *
 * backupTo 走 SQLite Online Backup API，不阻塞读写，所以可以与 indexer 并行。
 */
function scheduleBackups(): void {
  // 启动时延后 60s 先做检查，避免抢启动期 IO
  setTimeout(() => {
    runBackupIfDue().catch((err) => console.warn('Initial backup check failed:', err))
  }, 60_000)

  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => {
    runBackupIfDue().catch((err) => console.warn('Periodic backup failed:', err))
  }, 60 * 60 * 1000) // 每小时检查一次"是否到点"，真正动作受 last_backup_at 节流
}

async function runBackupIfDue(): Promise<void> {
  const last = parseInt(db.getMetaState(META_KEY_LAST_BACKUP) || '0', 10)
  const now = Date.now()
  if (now - last < BACKUP_INTERVAL_MS) return
  await runBackup()
}

async function runBackup(): Promise<{ path: string; sizeBytes: number }> {
  if (backupInFlight) {
    throw new Error('A backup is already in progress')
  }
  backupInFlight = true
  try {
    const backupsDir = join(app.getPath('userData'), 'backups')
    if (!existsSync(backupsDir)) {
      await mkdir(backupsDir, { recursive: true })
    }
    const name = formatBackupName(new Date())
    const dest = join(backupsDir, name)

    await db.backupTo(dest)

    // 写时间戳到 meta_state
    db.setMetaState(META_KEY_LAST_BACKUP, String(Date.now()))

    // 轮换：删除多余的旧备份（保留最近 BACKUP_KEEP_COUNT 份）
    const entries = await readdir(backupsDir)
    const expired = selectExpired(entries, BACKUP_KEEP_COUNT)
    for (const old of expired) {
      try {
        await unlink(join(backupsDir, old))
      } catch (err) {
        console.warn(`Failed to delete old backup ${old}:`, err)
      }
    }

    const { stat } = await import('fs/promises')
    const sizeBytes = (await stat(dest)).size
    return { path: dest, sizeBytes }
  } finally {
    backupInFlight = false
  }
}

function registerIpcHandlers(): void {
  // 搜索
  ipcMain.handle(IPC_CHANNELS.SEARCH, async (_event, query: string, limit?: number, options?: SearchOptions) => {
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
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow!, {
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.ADD_FOLDER, async (_event, folderPath: string) => {
    const folder = db.addFolder(folderPath)
    watcher.watchFolder(folder.id, folder.path)
    broadcastLibraryChanged()
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
      // 视频的代表帧 photo 也挂在该文件夹下，上面已一并删掉；这里清视频本体 + 片段 + 抽帧目录
      const videoHashes = db.deleteVideosByFolder(folderId)
      for (const hash of videoHashes) {
        await rm(indexer.getVideoFramesDir(hash), { recursive: true, force: true }).catch(() => {})
      }
      db.removeFolder(folderId)
      broadcastLibraryChanged()
    }
    return true
  })

  ipcMain.handle(IPC_CHANNELS.OPEN_SETTINGS, async () => openSettingsWindow())

  ipcMain.handle(IPC_CHANNELS.GET_THEME, async () => loadTheme())

  ipcMain.handle(IPC_CHANNELS.SET_THEME, async (_event, mode: ThemeMode) => {
    const next: ThemeMode = mode === 'light' || mode === 'dark' ? mode : 'system'
    db.setMetaState(META_KEY_THEME, next)
    applyTheme(next)
    return next
  })

  ipcMain.handle(IPC_CHANNELS.GET_INDEX_PAUSED, async () => {
    return indexer.isPaused()
  })

  ipcMain.handle(IPC_CHANNELS.SET_INDEX_PAUSED, async (_event, paused: boolean) => {
    indexer.setPaused(paused)
    return indexer.isPaused()
  })

  ipcMain.handle(IPC_CHANNELS.GET_TASK_OVERVIEW, async () => {
    return db.getTaskOverview()
  })

  ipcMain.handle(IPC_CHANNELS.RETRY_FAILED_TASKS, async (_event, ids?: number[]) => {
    const n = db.retryFailedTasks(ids)
    if (n > 0) indexer.processNext()
    indexer.emitProgressPublic()
    return n
  })

  ipcMain.handle(IPC_CHANNELS.CLEAR_FAILED_TASKS, async () => {
    const n = db.clearFailedTasks()
    indexer.emitProgressPublic()
    return n
  })

  ipcMain.handle(IPC_CHANNELS.GET_MEDIA_DETAIL, async (_event, videoId: number) => {
    return db.getMediaDetail(videoId) ?? null
  })

  ipcMain.handle(IPC_CHANNELS.GET_FOLDERS, async () => {
    return db.getFoldersWithStats()
  })

  ipcMain.handle(IPC_CHANNELS.GET_LIBRARY_COUNTS, async () => {
    return db.getLibraryCounts()
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

  ipcMain.handle(IPC_CHANNELS.SHOW_ITEM_MENU, async (event, opts: { count: number; isMedia: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? popupItemMenu(win, opts) : null
  })

  ipcMain.handle(IPC_CHANNELS.SHOW_IN_FINDER, async (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.GET_APP_PATH, async () => {
    return app.getPath('userData')
  })

  // 模型状态（EmbeddingGemma 2 本地模型）
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_STATUS, async () => {
    const embeddingService = getEmbeddingService()
    const config = embeddingService.getConfig()
    const gemma2Dir = join(bundledModelsDir, config.modelDirName || 'gemma2')
    const localModelExists = existsSync(gemma2Dir)

    return {
      modelsDir: bundledModelsDir,
      providerType: config.type, // 'gemma2-local'
      localModelExists,
      embeddingReady: embeddingService.isReady(),
      textQuantization: config.textQuantization,
      visionQuantization: config.visionQuantization,
      audioQuantization: config.audioQuantization,
      initError: embeddingService.getInitError(),
    }
  })

  // Embedding 配置：量化档位 / 推理设备（纯本地，无 API 后端）
  ipcMain.handle(IPC_CHANNELS.GET_EMBEDDING_CONFIG, async () => {
    const config = getEmbeddingService().getConfig()
    return {
      textQuantization: config.textQuantization,
      visionQuantization: config.visionQuantization,
      audioQuantization: config.audioQuantization,
      device: config.device,
    }
  })

  // 改量化档位会丢弃已加载的 provider，下次 encode 时按新档位重新加载。
  // 注意：换档位不会重建已有向量 —— 不同量化档位的向量仍在同一嵌入空间，
  // 可以混用，只是精度略有差异。
  ipcMain.handle(
    IPC_CHANNELS.SET_EMBEDDING_CONFIG,
    async (_event, patch: EmbeddingQuantizationConfig) => {
      try {
        const svc = getEmbeddingService()
        svc.setConfig(patch)
        await svc.init()
        return { success: true, ready: svc.isReady() }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

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

  // 打开视频源文件（系统默认播放器）
  ipcMain.handle(IPC_CHANNELS.OPEN_SOURCE_VIDEO, async (_event, videoId: number) => {
    try {
      const video = db.getVideoById(videoId)
      if (!video || !existsSync(video.filePath)) {
        return { success: false, error: '视频文件已不存在' }
      }
      const errMsg = await shell.openPath(video.filePath)
      if (errMsg) return { success: false, error: errMsg }
      return { success: true }
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

  // 备份：手动触发 + 状态查询
  ipcMain.handle(IPC_CHANNELS.TRIGGER_BACKUP, async () => {
    try {
      const result = await runBackup()
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.GET_BACKUP_STATUS, async () => {
    const last = parseInt(db.getMetaState(META_KEY_LAST_BACKUP) || '0', 10)
    const backupsDir = join(app.getPath('userData'), 'backups')
    let count = 0
    if (existsSync(backupsDir)) {
      const entries = await readdir(backupsDir)
      count = entries.filter((n) => n.startsWith('library.db.bak.')).length
    }
    return {
      lastBackupAt: last || null,
      intervalMs: BACKUP_INTERVAL_MS,
      keepCount: BACKUP_KEEP_COUNT,
      currentCount: count,
      inProgress: backupInFlight,
      backupsDir,
    }
  })
}

/**
 * 注册 vixel:// 自定义协议。必须在 app.ready 之前调用 registerSchemesAsPrivileged，
 * 否则渲染端 <img src="vixel://..."> 会被当作 opaque resource，CORS/CSP 阻塞。
 *
 *   vixel://thumb/<photoId>           → <userData>/thumbnails/<hash>.webp
 *   vixel://image/<photoId>           → 原图文件路径
 *   vixel://media/<videoId>           → 音视频源文件（手写 Range，供 <video>/<audio> seek）
 *
 * 比 base64-over-IPC 显著省事：
 *   - 主进程不必把文件读进字符串再 base64
 *   - IPC 不必序列化数 MB 的 data URL
 *   - 渲染端 <img> 直接走 Chromium 内置 file fetch，可被 GPU 解码
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'vixel', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
])

function registerVixelProtocol(): void {
  protocol.handle('vixel', async (request) => {
    try {
      const url = new URL(request.url)
      const host = url.host
      const pathParts = url.pathname.split('/').filter(Boolean)

      if (host === 'thumb' && pathParts.length === 1) {
        const id = parseInt(pathParts[0], 10)
        if (Number.isNaN(id)) return new Response('bad id', { status: 400 })
        const photo = db.getPhoto(id)
        if (!photo?.fileHash) return new Response('not found', { status: 404 })
        return net.fetch(pathToFileURL(indexer.getThumbnailPath(photo.fileHash)).toString())
      }

      if (host === 'image' && pathParts.length === 1) {
        const id = parseInt(pathParts[0], 10)
        if (Number.isNaN(id)) return new Response('bad id', { status: 400 })
        const photo = db.getPhoto(id)
        if (!photo || !existsSync(photo.filePath)) return new Response('not found', { status: 404 })
        return net.fetch(pathToFileURL(photo.filePath).toString())
      }

      if (host === 'media' && pathParts.length === 1) {
        const id = parseInt(pathParts[0], 10)
        if (Number.isNaN(id)) return new Response('bad id', { status: 400 })
        const video = db.getVideoById(id)
        if (!video || !existsSync(video.filePath)) return new Response('not found', { status: 404 })
        return serveMediaFile(video.filePath, request.headers.get('range'))
      }

      return new Response('unknown vixel path', { status: 404 })
    } catch (err) {
      console.error('vixel:// handler error:', err)
      return new Response(String(err), { status: 500 })
    }
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.vixel.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await initServices()
  applyTheme(loadTheme())
  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(windowBackground())
  })
  registerVixelProtocol()
  registerIpcHandlers()
  installAppMenu(() => mainWindow, { openSettings: openSettingsWindow })
  createWindow()

  // 只剩设置窗口时点 Dock 图标也要把主窗口找回来
  app.on('activate', () => {
    if (!mainWindow) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  watcher?.stopAll()
  if (backupTimer) {
    clearInterval(backupTimer)
    backupTimer = null
  }
  db?.close()
})
