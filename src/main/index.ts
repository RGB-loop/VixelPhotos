import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net, nativeTheme, session } from 'electron'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { writeFile, unlink, mkdir, readdir, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from '../core/db'
import { FileWatcher } from '../core/watcher'
import { Indexer } from '../core/indexer'
import { SearchEngine, type SearchOptions } from '../core/search'
import { getEmbeddingService, initEmbeddingServicePath } from '../core/embedding'
import { setFaceModelsDir, getFaceThumbnail, FACE_PIPELINE_VERSION } from '../core/face'
import { suggestMerges } from '../core/face/cluster'
import { setOcrModelsDir } from '../core/ocr'
import { preloadJieba } from '../core/text/tokenize'
import { formatBackupName, selectExpired } from '../core/backup'
import { serveMediaFile } from '../core/media/serve'
import { ensureSprite, SPRITE_MIN_DURATION_MS } from '../core/video/sprite'
import { isFfmpegAvailable, probeMedia } from '../core/video/extract'
import { installAppMenu, popupItemMenu } from './menu'
import { InferenceProcess } from './inference-client'
import { runCaptureTour } from './capture'
import { timed, watchEventLoop, perfSnapshot, PROFILE } from '../core/perf'
import { setInferenceTransport } from '../core/inference/transport'
import { IPC_CHANNELS, type ThemeMode, type IndexProgress, type FaceBbox, type EmbeddingQuantizationConfig, type PersonSuggestion, type PersonFace } from '../shared/types'

const APP_NAME = 'Vixel'

// 开发期 app.name 默认取 package.json 的 "vixel"，菜单 / 关于面板会显示小写名。
// setName 也会改默认 userData 目录，先记下原路径再设回去，老数据不搬家。
{
  const userData = app.getPath('userData')
  app.setName(APP_NAME)
  app.setPath('userData', userData)
}
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })

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
let inference: InferenceProcess | null = null
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
  // preload 只用 contextBridge / ipcRenderer（打包后只 require('electron')），可以开沙箱
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
}

/** 主窗口和设置窗口共用一个渲染入口，按 hash 区分（main.tsx 里路由） */
function loadRenderer(win: BrowserWindow, hash?: string): void {
  // VIXEL_PROFILE=1：渲染进程的警告 / 错误（含 [longtask]）汇进主进程日志，自动化跑一遍就能看全
  if (PROFILE) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.log(`[renderer${hash ? `:${hash}` : ''}] ${message}${level === 3 ? ` (${sourceId}:${line})` : ''}`)
    })
  }
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
  win.on('ready-to-show', () => {
    win.show()
    // VIXEL_CAPTURE=<目录>：自动巡检各视图并截图（见 capture.ts）
    if (process.env.VIXEL_CAPTURE) void runCaptureTour(win, process.env.VIXEL_CAPTURE)
  })
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

  // 推理（embedding / 人脸 / OCR）放到独立进程，主进程事件循环不被模型前向占住
  inference = new InferenceProcess(join(__dirname, 'inference.js'))
  setInferenceTransport(inference)
  initEmbeddingServicePath(userDataPath, bundledModelsDir)
  setFaceModelsDir(bundledModelsDir)
  setOcrModelsDir(bundledModelsDir)

  db = initDatabase(dbPath)
  db.recoverStuckTasks()
  db.pruneDoneTasks()
  db.requeueMissingEmbeddings()

  // v2：修复对齐（之前送进模型的是黑图，embedding 全部无效）→ 清空重扫
  const staleFaces = db.resetFacesIfStale(FACE_PIPELINE_VERSION)

  indexer = new Indexer(db, userDataPath)
  indexer.on('progress', (progress: IndexProgress) => {
    mainWindow?.webContents.send(IPC_CHANNELS.INDEX_PROGRESS, progress)
  })
  indexer.on('people-changed', () => {
    mainWindow?.webContents.send(IPC_CHANNELS.PEOPLE_CHANGED)
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
    // 上次退出时没跑完的任务：启动对账会跳过所有未变化的文件，不会再有 add 事件去触发队列
    indexer.processNext()
    // 补 OCR：已索引但从没做过文字识别的内容（以前只能在设置里手动触发）
    void indexer.ocrAvailable().then((ok) => {
      if (!ok) return
      const stale = indexer.resetOcrIfStale()
      if (stale > 0) console.log(`[ocr] pipeline upgraded, re-scanning (${stale} old results dropped)`)
      return indexer.startOcrScan()
    }).catch((e) => console.warn('[ocr] catch-up scan failed:', e))
    // 模型加载完推一次进度：库已全部索引时队列不动、不会有进度事件，状态栏的"模型未就绪"要靠这一下清掉
    indexer.preloadModels().catch(() => {}).finally(() => indexer.emitProgressPublic())
    // 用户扫过人脸才自动重扫；从没扫过的库保持手动触发
    // 上次退出前没来得及聚类的脸（或旧版本留下的未归属脸）
    if (db.countPendingClusterFaces() > 0) void indexer.faceClusterer.run()
    if (staleFaces > 0) {
      console.log(`[face] pipeline upgraded, re-scanning (${staleFaces} stale faces dropped)`)
      indexer.startFaceScan().catch((e) => console.warn('[face] re-scan failed:', e))
    } else if (indexer.isFaceAutoEnabled()) {
      const videoRescan = indexer.rescanVideoFacesOnce()
      if (videoRescan > 0) console.log(`[face] re-scanning ${videoRescan} video frames at full resolution`)
      // 补扫：上次之后入库、还没扫过人脸的媒体（以前只有手动点"扫描人脸"才会排）
      indexer.startFaceScan().catch((e) => console.warn('[face] catch-up scan failed:', e))
    }
  }, 2000)

  // VIXEL_PROFILE=1：主进程事件循环被同步工作占住 > 50ms 时打印，带上当前索引任务
  watchEventLoop('main', () => indexer.currentTaskLabel())

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

/**
 * 人脸裁剪缓存：<userData>/face_thumbs/<hash>-<bbox摘要>.jpg。
 * 原来每次请求都读整张原图再裁，人物页几十张脸就是几十次全图解码。
 * 键用内容 hash + bbox 而不是 faceId：重扫后 id 可能复用，内容键不会串。
 */
const faceThumbInflight = new Map<string, Promise<string | null>>()

async function ensureFaceThumb(faceId: number): Promise<string | null> {
  const info = db.getFaceCoverInfo(faceId)
  if (!info) return null
  const key = `${info.fileHash}-${createHash('sha1').update(info.bbox).digest('hex').slice(0, 12)}`
  const dest = join(app.getPath('userData'), 'face_thumbs', `${key}.jpg`)
  if (existsSync(dest)) return dest
  let p = faceThumbInflight.get(key)
  if (!p) {
    p = (async () => {
      const photo = db.getRepresentativeByHash(info.fileHash)
      if (!photo) return null
      // 与检测同源：视频取全分辨率帧，照片取原图
      const crop = await getFaceThumbnail(await indexer.analysisImage(photo), JSON.parse(info.bbox) as FaceBbox)
      await mkdir(join(app.getPath('userData'), 'face_thumbs'), { recursive: true })
      await writeFile(dest, crop)
      return dest
    })().finally(() => faceThumbInflight.delete(key))
    faceThumbInflight.set(key, p)
  }
  return p
}

/** 缩略图 / 人脸裁剪 / sprite 都按内容寻址，不会变：让 Chromium 缓存，滚动重挂时不再回到主进程 */
async function immutable(res: Response): Promise<Response> {
  if (!res.ok) return res
  const headers = new Headers(res.headers)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  return new Response(res.body, { status: res.status, headers })
}

/**
 * 隐私承诺落到代码上：渲染进程只许访问本地（vixel:// / file:// / devtools / 开发服务器），
 * 唯一例外是地图底图瓦片 —— 只在打开地图视图时请求，只带瓦片坐标、不带任何照片数据。
 * 模型推理在 utilityProcess 里，且 transformers.js 已关掉远程模型（allowRemoteModels = false）。
 */
const NETWORK_ALLOWLIST = [/^https:\/\/[a-d]\.basemaps\.cartocdn\.com\//]

function enforceOfflinePolicy(): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const url = details.url
      const allowed = (is.dev && devServer && (url.startsWith(devServer) || /^wss?:\/\/localhost[:/]/.test(url))) ||
        NETWORK_ALLOWLIST.some((re) => re.test(url))
      if (!allowed) console.warn(`[privacy] blocked network request: ${url}`)
      callback({ cancel: !allowed })
    }
  )
}

function registerIpcHandlers(): void {
  // VIXEL_PROFILE=1 时每个 handler 计时：主进程同步工作 > 16ms 就会让界面掉帧
  const handle = (channel: string, fn: Parameters<typeof ipcMain.handle>[1]): void =>
    ipcMain.handle(channel, timed('ipc', channel, fn))

  // 搜索
  handle(IPC_CHANNELS.SEARCH, async (_event, query: string, limit?: number, options?: SearchOptions) => {
    return searchEngine.search(query, limit, options)
  })

  handle(IPC_CHANNELS.GET_PHOTOS_WITH_GPS, async () => {
    return db.getPhotosWithGPS()
  })

  handle(IPC_CHANNELS.FIND_SIMILAR, async (_event, photoId: number, limit?: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return []
    return searchEngine.findSimilar(photo.fileHash, limit || 12)
  })

  handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? mainWindow!, {
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  handle(IPC_CHANNELS.ADD_FOLDER, async (_event, folderPath: string) => {
    const folder = db.addFolder(folderPath)
    watcher.watchFolder(folder.id, folder.path)
    broadcastLibraryChanged()
    return folder
  })

  handle(IPC_CHANNELS.REMOVE_FOLDER, async (_event, folderId: number) => {
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

  handle(IPC_CHANNELS.OPEN_SETTINGS, async () => openSettingsWindow())

  handle(IPC_CHANNELS.GET_THEME, async () => loadTheme())

  handle(IPC_CHANNELS.SET_THEME, async (_event, mode: ThemeMode) => {
    const next: ThemeMode = mode === 'light' || mode === 'dark' ? mode : 'system'
    db.setMetaState(META_KEY_THEME, next)
    applyTheme(next)
    return next
  })

  handle(IPC_CHANNELS.GET_INDEX_PAUSED, async () => {
    return indexer.isPaused()
  })

  handle(IPC_CHANNELS.SET_INDEX_PAUSED, async (_event, paused: boolean) => {
    indexer.setPaused(paused)
    return indexer.isPaused()
  })

  handle(IPC_CHANNELS.GET_TASK_OVERVIEW, async () => {
    return db.getTaskOverview()
  })

  handle(IPC_CHANNELS.RETRY_FAILED_TASKS, async (_event, ids?: number[]) => {
    const n = db.retryFailedTasks(ids)
    if (n > 0) indexer.processNext()
    indexer.emitProgressPublic()
    return n
  })

  handle(IPC_CHANNELS.CLEAR_FAILED_TASKS, async () => {
    const n = db.clearFailedTasks()
    indexer.emitProgressPublic()
    return n
  })

  handle(IPC_CHANNELS.GET_MEDIA_DETAIL, async (_event, videoId: number) => {
    const detail = db.getMediaDetail(videoId)
    // 老版本索引的视频没记分辨率：第一次打开时探一下补上（ffmpeg -i 只读文件头，几十毫秒）
    if (detail && detail.kind === 'video' && detail.width == null && existsSync(detail.filePath) && isFfmpegAvailable()) {
      const probe = await probeMedia(detail.filePath).catch(() => null)
      if (probe?.width && probe.height) {
        db.updateVideoMeta(videoId, { width: probe.width, height: probe.height })
        return { ...detail, width: probe.width, height: probe.height }
      }
    }
    return detail ?? null
  })

  handle(IPC_CHANNELS.GET_FOLDERS, async () => {
    return db.getFoldersWithStats()
  })

  handle(IPC_CHANNELS.GET_LIBRARY_COUNTS, async () => {
    return db.getLibraryCounts()
  })

  handle(IPC_CHANNELS.GET_FOLDER_STATS, async (_event, folderId: number) => {
    return db.getFolderStats(folderId)
  })

  handle(IPC_CHANNELS.GET_PHOTO_DETAIL, async (_event, photoId: number) => {
    return db.getPhotoDetail(photoId)
  })

  handle(IPC_CHANNELS.GET_THUMBNAIL, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return null
    return indexer.getThumbnailPath(photo.fileHash)
  })

  handle(IPC_CHANNELS.GET_PHOTO_LOCATIONS, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return []
    return db.getPhotoLocations(photo.fileHash)
  })

  handle(IPC_CHANNELS.SHOW_ITEM_MENU, async (event, opts: { count: number; isMedia: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? popupItemMenu(win, opts) : null
  })

  // 只对库里登记过的媒体 / 监控目录生效：渲染进程传来的任意路径不直接交给 shell
  handle(IPC_CHANNELS.SHOW_IN_FINDER, async (_event, filePath: string) => {
    const known = typeof filePath === 'string' && (
      !!db.getPhotoByPath(filePath) || !!db.getVideoByPath(filePath) ||
      db.getFolders().some((f) => f.path === filePath)
    )
    if (!known) return false
    shell.showItemInFolder(filePath)
    return true
  })

  handle(IPC_CHANNELS.GET_APP_PATH, async () => {
    return app.getPath('userData')
  })

  // 模型状态（EmbeddingGemma 2 本地模型）
  handle(IPC_CHANNELS.GET_MODEL_STATUS, async () => {
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
  handle(IPC_CHANNELS.GET_EMBEDDING_CONFIG, async () => {
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
  handle(IPC_CHANNELS.UPDATE_CAPTION, async (_event, photoId: number, text: string) => {
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
  handle(IPC_CHANNELS.START_FACE_SCAN, async () => {
    try {
      return await indexer.startFaceScan()
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // OCR 扫描
  handle(IPC_CHANNELS.START_OCR_SCAN, async () => {
    try {
      return await indexer.startOcrScan()
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 打开视频源文件（系统默认播放器）
  handle(IPC_CHANNELS.OPEN_SOURCE_VIDEO, async (_event, videoId: number) => {
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

  handle(IPC_CHANNELS.GET_PEOPLE, async () => {
    return db.getPeople()
  })

  handle(IPC_CHANNELS.GET_PERSON_PHOTOS, async (_event, personId: number, limit?: number) => {
    const photos = db.getPersonPhotos(personId, limit || 50)
    return photos.map((p) => ({ photo: p, score: 1.0 }))
  })

  handle(IPC_CHANNELS.SET_PERSON_NAME, async (_event, personId: number, name: string) => {
    db.updatePersonName(personId, name)
    return { success: true }
  })

  handle(IPC_CHANNELS.MERGE_PEOPLE, async (_event, targetId: number, sourceIds: number[]) => {
    db.mergePeople(targetId, sourceIds)
    return { success: true }
  })

  handle(IPC_CHANNELS.GET_PERSON_SUGGESTIONS, async (): Promise<PersonSuggestion[]> => {
    const people = new Map(db.getPeople().filter((p) => !p.hidden).map((p) => [p.id, p]))
    const centroids = db.getPersonCentroids().filter((c) => people.has(c.id))
    return suggestMerges(centroids, db.getDismissedPairs(), 10).map((s) => ({
      a: people.get(s.a)!, b: people.get(s.b)!, similarity: s.similarity,
    }))
  })

  handle(IPC_CHANNELS.DISMISS_PERSON_SUGGESTION, async (_event, a: number, b: number) => {
    db.dismissPersonPair(a, b)
    return { success: true }
  })

  handle(IPC_CHANNELS.GET_PERSON_FACES, async (_event, personId: number, limit?: number): Promise<PersonFace[]> => {
    return db.getPersonFaces(personId, limit).map((f) => ({ id: f.id, quality: f.quality, assignedBy: f.assignedBy as PersonFace['assignedBy'] }))
  })

  handle(IPC_CHANNELS.REJECT_FACE, async (_event, faceId: number) => {
    db.rejectFaceFromPerson(faceId)
    return { success: true }
  })

  handle(IPC_CHANNELS.ASSIGN_FACE, async (_event, faceId: number, personId: number) => {
    db.assignFaceManually(faceId, personId)
    return { success: true }
  })

  handle(IPC_CHANNELS.SET_PERSON_HIDDEN, async (_event, personId: number, hidden: boolean) => {
    db.setPersonHidden(personId, hidden)
    return { success: true }
  })

  handle(IPC_CHANNELS.GET_PHOTO_FACES, async (_event, photoId: number) => {
    const photo = db.getPhoto(photoId)
    if (!photo?.fileHash) return []
    return db.getFacesByHash(photo.fileHash)
  })

  // 备份：手动触发 + 状态查询
  handle(IPC_CHANNELS.TRIGGER_BACKUP, async () => {
    try {
      const result = await runBackup()
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  handle(IPC_CHANNELS.GET_BACKUP_STATUS, async () => {
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
 *   vixel://sprite/<videoId>          → 悬停拖动预览 sprite；老视频没有时按需生成
 *   vixel://face/<faceId>             → 人脸裁剪（磁盘缓存）
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
  protocol.handle('vixel', timed('proto', 'vixel://', async (request: Request) => {
    try {
      const url = new URL(request.url)
      const host = url.host
      const pathParts = url.pathname.split('/').filter(Boolean)

      if (host === 'thumb' && pathParts.length === 1) {
        const id = parseInt(pathParts[0], 10)
        if (Number.isNaN(id)) return new Response('bad id', { status: 400 })
        const photo = db.getPhoto(id)
        if (!photo?.fileHash) return new Response('not found', { status: 404 })
        // 新导入的照片先进网格、缩略图稍后才生成：安静地 404（不缓存），卡片会自己重试
        const thumbPath = indexer.getThumbnailPath(photo.fileHash)
        if (!existsSync(thumbPath)) return new Response('not ready', { status: 404 })
        return immutable(await net.fetch(pathToFileURL(thumbPath).toString()))
      }

      if (host === 'face' && pathParts.length === 1) {
        const id = parseInt(pathParts[0], 10)
        if (Number.isNaN(id)) return new Response('bad id', { status: 400 })
        const path = await ensureFaceThumb(id)
        if (!path) return new Response('not found', { status: 404 })
        return immutable(await net.fetch(pathToFileURL(path).toString()))
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

      if (host === 'sprite' && pathParts.length === 1) {
        const id = parseInt(pathParts[0], 10)
        if (Number.isNaN(id)) return new Response('bad id', { status: 400 })
        const video = db.getVideoById(id)
        if (!video || video.mediaKind !== 'video') return new Response('not found', { status: 404 })
        const spritePath = indexer.getSpritePath(video.fileHash)
        if (!existsSync(spritePath)) {
          // 还没抽过帧（时长未知）的视频交给索引任务，这里不抢
          if (!video.durationMs || video.durationMs < SPRITE_MIN_DURATION_MS || !existsSync(video.filePath) || !isFfmpegAvailable()) {
            return new Response('not ready', { status: 404 })
          }
          await ensureSprite(video.filePath, video.durationMs, spritePath)
        }
        return immutable(await net.fetch(pathToFileURL(spritePath).toString()))
      }

      return new Response('unknown vixel path', { status: 404 })
    } catch (err) {
      console.error('vixel:// handler error:', err)
      return new Response(String(err), { status: 500 })
    }
  }))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.vixel.app')
  // 开发期 Dock 图标兜底；名字 / ⌘Tab 图标靠 predev 的 scripts/dev-bundle.mjs 改 Electron.app
  if (is.dev && process.platform === 'darwin') {
    const icon = join(app.getAppPath(), 'build/icon.png')
    if (existsSync(icon)) app.dock?.setIcon(icon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await initServices()
  applyTheme(loadTheme())
  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(windowBackground())
  })
  enforceOfflinePolicy()
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
  // VIXEL_PROFILE=1：退出时打印本次会话最慢的操作（p50 / p95 / max）
  if (PROFILE) console.table(perfSnapshot().slice(0, 25).map((r) => ({ ...r, p50: +r.p50.toFixed(1), p95: +r.p95.toFixed(1), max: +r.max.toFixed(1) })))
  watcher?.stopAll()
  // 先停 indexer（清掉节流中的进度定时器），否则它可能在 db.close() 之后触发并查询已关闭的库
  indexer?.stop()
  inference?.stop()
  if (backupTimer) {
    clearInterval(backupTimer)
    backupTimer = null
  }
  db?.close()
})
