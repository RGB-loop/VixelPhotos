import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { getDownloadManager } from './downloadManager'

export interface LlamaServerConfig {
  modelPath: string
  mmprojPath: string
  port?: number
  host?: string
  contextSize?: number
  gpuLayers?: number
}

export class LlamaServer {
  private process: ChildProcess | null = null
  private config: LlamaServerConfig
  private isReady = false
  private startPromise: Promise<void> | null = null
  private modelsDir: string
  private binDir: string

  constructor(config?: Partial<LlamaServerConfig>) {
    this.modelsDir = join(app.getPath('userData'), 'models')
    this.binDir = join(app.getPath('userData'), 'bin')

    this.config = {
      modelPath: config?.modelPath || join(this.modelsDir, 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'),
      mmprojPath: config?.mmprojPath || join(this.modelsDir, 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'),
      port: config?.port || 8847,
      host: config?.host || '127.0.0.1',
      contextSize: config?.contextSize || 4096,
      gpuLayers: config?.gpuLayers || 99, // 尽量使用 GPU
    }
  }

  /**
   * 获取 llama-server 可执行文件路径
   */
  private getLlamaServerPath(): string {
    const downloadManager = getDownloadManager()
    return downloadManager.getLlamaServerPath()
  }

  /**
   * 检查 llama-server 是否已安装
   */
  isLlamaServerInstalled(): boolean {
    const downloadManager = getDownloadManager()
    return downloadManager.isLlamaServerInstalled()
  }

  /**
   * 检查模型文件是否存在
   */
  checkModels(): { model: boolean; mmproj: boolean } {
    return {
      model: existsSync(this.config.modelPath),
      mmproj: existsSync(this.config.mmprojPath),
    }
  }

  /**
   * 获取模型目录路径
   */
  getModelsDir(): string {
    return this.modelsDir
  }

  /**
   * 启动 llama-server
   */
  async start(): Promise<void> {
    if (this.isReady) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this._start()
    return this.startPromise
  }

  private async _start(): Promise<void> {
    // 确保模型目录存在
    if (!existsSync(this.modelsDir)) {
      await mkdir(this.modelsDir, { recursive: true })
    }

    // 检查 llama-server 是否已安装
    if (!this.isLlamaServerInstalled()) {
      throw new Error(
        'llama-server is not installed. Please download it from the Settings > AI Model tab.'
      )
    }

    // 检查模型文件
    const models = this.checkModels()
    if (!models.model || !models.mmproj) {
      const missing: string[] = []
      if (!models.model) missing.push('Qwen3VL-4B-Instruct-Q4_K_M.gguf')
      if (!models.mmproj) missing.push('mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf')
      throw new Error(
        `Missing model files: ${missing.join(', ')}. ` +
          `Please download from the Settings > AI Model tab.`
      )
    }

    const serverPath = this.getLlamaServerPath()

    // 使用本地模型文件
    // -m: 主模型文件
    // --mmproj: 多模态投影器（用于视觉理解）
    const args = [
      '-m', this.config.modelPath,
      '--mmproj', this.config.mmprojPath,
      '--host', this.config.host!,
      '--port', this.config.port!.toString(),
      '-c', this.config.contextSize!.toString(),
      '-ngl', this.config.gpuLayers!.toString(),
    ]

    console.log(`Starting llama-server: ${serverPath} ${args.join(' ')}`)

    return new Promise((resolve, reject) => {
      this.process = spawn(serverPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let startupOutput = ''

      this.process.stdout?.on('data', (data) => {
        const output = data.toString()
        startupOutput += output

        // 检测服务器就绪 - 支持多种格式
        // 旧版: "HTTP server listening"
        // 新版: "server is listening on http://..."
        if (output.includes('server listening') || output.includes('server is listening')) {
          console.log('llama-server is ready')
          this.isReady = true
          resolve()
        }
      })

      this.process.stderr?.on('data', (data) => {
        const output = data.toString()
        startupOutput += output

        // llama-server 的一些输出会走 stderr
        if (output.includes('server listening') || output.includes('server is listening')) {
          console.log('llama-server is ready')
          this.isReady = true
          resolve()
        }
      })

      this.process.on('error', (err) => {
        console.error('llama-server error:', err)
        this.isReady = false
        reject(new Error(`Failed to start llama-server: ${err.message}`))
      })

      this.process.on('exit', (code) => {
        console.log(`llama-server exited with code ${code}`)
        this.isReady = false
        this.process = null

        if (!this.isReady) {
          reject(new Error(`llama-server exited unexpectedly. Output: ${startupOutput}`))
        }
      })

      // 超时检测
      setTimeout(() => {
        if (!this.isReady) {
          this.stop()
          reject(new Error(`llama-server startup timeout. Output: ${startupOutput}`))
        }
      }, 120000) // 2 分钟超时（首次加载模型可能较慢）
    })
  }

  /**
   * 停止 llama-server
   */
  stop(): void {
    if (this.process) {
      console.log('Stopping llama-server...')
      this.process.kill('SIGTERM')
      this.process = null
      this.isReady = false
      this.startPromise = null
    }
  }

  /**
   * 检查服务器是否就绪
   */
  isServerReady(): boolean {
    return this.isReady
  }

  /**
   * 获取 API 基础 URL
   */
  getBaseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/health`)
      return response.ok
    } catch {
      return false
    }
  }
}

// 单例
let llamaServer: LlamaServer | null = null

export function getLlamaServer(): LlamaServer {
  if (!llamaServer) {
    llamaServer = new LlamaServer()
  }
  return llamaServer
}
