import { app } from 'electron'
import { join, basename, dirname } from 'path'
import { createWriteStream, existsSync, mkdirSync, chmodSync } from 'fs'
import { mkdir, rm, rename, copyFile } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { createGunzip } from 'zlib'
import { Extract } from 'unzip-stream'

export interface DownloadProgress {
  file: string
  downloaded: number
  total: number
  percent: number
  speed: number // bytes per second
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void

// 模型文件信息
// 使用 Qwen3-VL-4B (Vision-Language) 而不是 Qwen3.5-4B (纯文本)
// Qwen3-VL 支持图像理解，可以生成图片描述
export const MODEL_FILES = {
  model: {
    name: 'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3VL-4B-Instruct-Q4_K_M.gguf',
    size: 2_497_281_664, // ~2.5GB
  },
  mmproj: {
    name: 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',
    size: 453_974_304, // ~454MB
  },
}

// llama.cpp release 信息
// Qwen3-VL support requires a recent llama.cpp version
// Using b8300+ which includes full Qwen3-VL architecture support
const LLAMA_CPP_VERSION = 'b8300'
const LLAMA_CPP_RELEASES: Record<string, { url: string; format: 'zip' | 'tar.gz' }> = {
  'darwin-arm64': {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.tar.gz`,
    format: 'tar.gz',
  },
  'darwin-x64': {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-macos-x64.tar.gz`,
    format: 'tar.gz',
  },
  'win32-x64': {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-win-cuda-12.4-x64.zip`,
    format: 'zip',
  },
  'linux-x64': {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-ubuntu-x64.tar.gz`,
    format: 'tar.gz',
  },
}

export class DownloadManager {
  private modelsDir: string
  private binDir: string
  private tempDir: string
  private abortControllers: Map<string, AbortController> = new Map()

  constructor() {
    const userDataPath = app.getPath('userData')
    this.modelsDir = join(userDataPath, 'models')
    this.binDir = join(userDataPath, 'bin')
    this.tempDir = join(userDataPath, 'temp')

    // 确保目录存在
    this.ensureDirs()
  }

  private ensureDirs(): void {
    for (const dir of [this.modelsDir, this.binDir, this.tempDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }
  }

  getModelsDir(): string {
    return this.modelsDir
  }

  getBinDir(): string {
    return this.binDir
  }

  /**
   * 检查 llama-server 是否已安装
   */
  isLlamaServerInstalled(): boolean {
    const serverPath = join(this.binDir, 'llama-server')
    const exists = existsSync(serverPath)
    console.log(`Checking llama-server at: ${serverPath}, exists: ${exists}`)
    return exists
  }

  /**
   * 获取 llama-server 路径
   */
  getLlamaServerPath(): string {
    return join(this.binDir, 'llama-server')
  }

  /**
   * 下载并安装 llama-server
   */
  async installLlamaServer(onProgress?: DownloadProgressCallback): Promise<void> {
    const platform = process.platform
    const arch = process.arch
    const key = `${platform}-${arch}`

    const release = LLAMA_CPP_RELEASES[key]
    if (!release) {
      throw new Error(`Unsupported platform: ${key}`)
    }

    const archiveExt = release.format === 'tar.gz' ? '.tar.gz' : '.zip'
    const archivePath = join(this.tempDir, `llama-cpp${archiveExt}`)
    const extractDir = join(this.tempDir, 'llama-cpp')

    try {
      // 下载归档文件
      await this.downloadFile(release.url, archivePath, 'llama-server', onProgress)

      // 解压
      if (release.format === 'tar.gz') {
        await this.extractTarGz(archivePath, extractDir)
      } else {
        await this.extractZip(archivePath, extractDir)
      }

      // 找到 bin 目录并复制所有文件
      const { globSync } = await import('glob')
      const serverName = platform === 'win32' ? 'llama-server.exe' : 'llama-server'

      // 查找 llama-server
      const matches = globSync(`${extractDir}/**/${serverName}`)
      if (matches.length === 0) {
        throw new Error(`llama-server not found in extracted files`)
      }

      const serverSourcePath = matches[0]
      const binSourceDir = dirname(serverSourcePath)

      console.log(`Found llama-server at: ${serverSourcePath}`)
      console.log(`Copying all files from: ${binSourceDir}`)

      // 复制 bin 目录下所有文件到我们的 bin 目录
      const allFiles = globSync(`${binSourceDir}/*`)
      for (const file of allFiles) {
        const fileName = basename(file)
        const targetPath = join(this.binDir, fileName)
        await copyFile(file, targetPath)

        // 设置可执行权限
        if (platform !== 'win32' && (fileName.endsWith('.dylib') || !fileName.includes('.'))) {
          chmodSync(targetPath, 0o755)
        }
      }

      console.log(`llama-server installed to: ${this.binDir}`)
    } finally {
      // 清理临时文件
      await rm(archivePath, { force: true }).catch(() => {})
      await rm(extractDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 下载模型文件
   */
  async downloadModel(
    type: 'model' | 'mmproj',
    onProgress?: DownloadProgressCallback
  ): Promise<void> {
    const fileInfo = MODEL_FILES[type]
    const targetPath = join(this.modelsDir, fileInfo.name)

    if (existsSync(targetPath)) {
      console.log(`Model already exists: ${targetPath}`)
      return
    }

    await this.downloadFile(fileInfo.url, targetPath, fileInfo.name, onProgress)
  }

  /**
   * 取消下载
   */
  cancelDownload(fileName: string): void {
    const controller = this.abortControllers.get(fileName)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(fileName)
    }
  }

  /**
   * 通用文件下载
   */
  private async downloadFile(
    url: string,
    targetPath: string,
    displayName: string,
    onProgress?: DownloadProgressCallback
  ): Promise<void> {
    const controller = new AbortController()
    this.abortControllers.set(displayName, controller)

    const tempPath = targetPath + '.tmp'

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Vixel/1.0',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
      const reader = response.body?.getReader()

      if (!reader) {
        throw new Error('Response body is not readable')
      }

      const fileStream = createWriteStream(tempPath)
      let downloaded = 0
      let lastTime = Date.now()
      let lastDownloaded = 0

      while (true) {
        const { done, value } = await reader.read()

        if (done) break

        fileStream.write(value)
        downloaded += value.length

        // 计算进度
        const now = Date.now()
        const elapsed = (now - lastTime) / 1000
        if (elapsed >= 0.5 && onProgress) {
          const speed = (downloaded - lastDownloaded) / elapsed
          onProgress({
            file: displayName,
            downloaded,
            total: contentLength,
            percent: contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0,
            speed,
          })
          lastTime = now
          lastDownloaded = downloaded
        }
      }

      fileStream.end()

      // 等待写入完成
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })

      // 重命名临时文件
      await rename(tempPath, targetPath)

      console.log(`Downloaded: ${targetPath}`)
    } catch (error) {
      // 清理临时文件
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    } finally {
      this.abortControllers.delete(displayName)
    }
  }

  /**
   * 解压 zip 文件
   */
  private async extractZip(zipPath: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true })

    return new Promise((resolve, reject) => {
      const { createReadStream } = require('fs')
      const unzip = require('unzip-stream')

      createReadStream(zipPath)
        .pipe(unzip.Extract({ path: targetDir }))
        .on('close', resolve)
        .on('error', reject)
    })
  }

  /**
   * 解压 tar.gz 文件
   */
  private async extractTarGz(tarPath: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true })

    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    // 使用系统 tar 命令解压（macOS 和 Linux 都自带）
    await execAsync(`tar -xzf "${tarPath}" -C "${targetDir}"`)
  }
}

// 单例
let downloadManager: DownloadManager | null = null

export function getDownloadManager(): DownloadManager {
  if (!downloadManager) {
    downloadManager = new DownloadManager()
  }
  return downloadManager
}
