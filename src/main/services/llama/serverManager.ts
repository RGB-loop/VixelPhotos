/**
 * llama-server 管理器
 * 支持单实例运行，按需切换模型（embedding / caption）
 */

import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'
import type {
  ModelType,
  ModelConfig,
  LlamaServerConfig,
  EmbeddingRequest,
  EmbeddingResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from './types'

const DEFAULT_PORT = 8080
const SERVER_READY_TIMEOUT = 120000 // 2 分钟

export class LlamaServerManager extends EventEmitter {
  private process: ChildProcess | null = null
  private currentModel: ModelType | null = null
  private isReady = false
  private isSwitching = false
  private config: LlamaServerConfig
  private llamaServerPath: string

  constructor(userDataPath: string, config?: Partial<LlamaServerConfig>) {
    super()
    // llama-server 安装在 bin 目录
    this.llamaServerPath = join(userDataPath, 'bin', 'llama-server')

    this.config = {
      port: config?.port ?? DEFAULT_PORT,
      host: config?.host ?? '127.0.0.1',
      models: config?.models ?? {
        embedding: {
          type: 'embedding',
          modelPath: '',
          mmprojPath: '',
          embeddingMode: true,
          poolingType: 'last',
          contextSize: 8192,
        },
        caption: {
          type: 'caption',
          modelPath: '',
          mmprojPath: '',
          contextSize: 8192,
        },
      },
    }
  }

  /**
   * 更新模型配置
   */
  setModelConfig(type: ModelType, config: Partial<ModelConfig>): void {
    this.config.models[type] = { ...this.config.models[type], ...config, type }
  }

  /**
   * 获取当前加载的模型类型
   */
  getCurrentModel(): ModelType | null {
    return this.currentModel
  }

  /**
   * 检查服务是否就绪
   */
  isServerReady(): boolean {
    return this.isReady && this.process !== null
  }

  /**
   * 检查指定模型是否已加载
   */
  isModelLoaded(type: ModelType): boolean {
    return this.isReady && this.currentModel === type
  }

  /**
   * 确保指定模型已加载，如果需要则切换
   */
  async ensureModel(type: ModelType): Promise<void> {
    if (this.isModelLoaded(type)) {
      return
    }

    if (this.isSwitching) {
      // 等待切换完成
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (!this.isSwitching) {
            resolve()
          } else {
            setTimeout(check, 100)
          }
        }
        check()
      })

      if (this.isModelLoaded(type)) {
        return
      }
    }

    await this.switchModel(type)
  }

  /**
   * 切换模型
   */
  async switchModel(type: ModelType): Promise<void> {
    if (this.isSwitching) {
      throw new Error('Model switch already in progress')
    }

    const modelConfig = this.config.models[type]
    if (!modelConfig.modelPath || !existsSync(modelConfig.modelPath)) {
      throw new Error(`Model not found: ${modelConfig.modelPath}`)
    }

    this.isSwitching = true
    this.emit('switching', { from: this.currentModel, to: type })

    try {
      // 停止当前实例
      if (this.process) {
        await this.stop()
      }

      // 启动新模型
      await this.start(type)
      this.emit('switched', { model: type })
    } finally {
      this.isSwitching = false
    }
  }

  /**
   * 启动服务
   */
  private async start(type: ModelType): Promise<void> {
    const modelConfig = this.config.models[type]

    if (!existsSync(this.llamaServerPath)) {
      throw new Error(`llama-server not found: ${this.llamaServerPath}`)
    }

    const args = [
      '--model', modelConfig.modelPath,
      '--port', String(this.config.port),
      '--host', this.config.host,
      '-c', String(modelConfig.contextSize || 8192),
    ]

    // 视觉模型需要 mmproj
    if (modelConfig.mmprojPath && existsSync(modelConfig.mmprojPath)) {
      args.push('--mmproj', modelConfig.mmprojPath)
    }

    // embedding 模式
    if (modelConfig.embeddingMode) {
      args.push('--embedding')
      if (modelConfig.poolingType) {
        args.push('--pooling', modelConfig.poolingType)
      }
    }

    // caption 模式：禁用 Qwen3.5 的 thinking 模式
    if (type === 'caption') {
      args.push('--chat-template-kwargs', '{"enable_thinking":false}')
    }

    console.log(`Starting llama-server with ${type} model...`)
    console.log(`Command: ${this.llamaServerPath} ${args.join(' ')}`)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('llama-server startup timeout'))
      }, SERVER_READY_TIMEOUT)

      this.process = spawn(this.llamaServerPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      this.process.stdout?.on('data', (data) => {
        const output = data.toString()
        console.log(`[llama-server] ${output}`)

        if (output.includes('server listening') || output.includes('server is listening')) {
          clearTimeout(timeout)
          this.isReady = true
          this.currentModel = type
          console.log(`llama-server ready with ${type} model`)
          resolve()
        }
      })

      this.process.stderr?.on('data', (data) => {
        const output = data.toString()
        console.error(`[llama-server stderr] ${output}`)

        // 有些日志输出在 stderr
        if (output.includes('server listening') || output.includes('server is listening')) {
          clearTimeout(timeout)
          this.isReady = true
          this.currentModel = type
          console.log(`llama-server ready with ${type} model`)
          resolve()
        }
      })

      this.process.on('error', (err) => {
        clearTimeout(timeout)
        console.error('llama-server process error:', err)
        reject(err)
      })

      this.process.on('exit', (code) => {
        clearTimeout(timeout)
        this.isReady = false
        this.currentModel = null
        this.process = null
        console.log(`llama-server exited with code ${code}`)
        this.emit('exit', { code })
      })
    })
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    if (!this.process) return

    return new Promise((resolve) => {
      const proc = this.process!

      const timeout = setTimeout(() => {
        console.log('Force killing llama-server...')
        proc.kill('SIGKILL')
        resolve()
      }, 5000)

      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      console.log('Stopping llama-server...')
      proc.kill('SIGTERM')
      this.isReady = false
      this.currentModel = null
      this.process = null
    })
  }

  /**
   * 获取 API 基础 URL
   */
  getBaseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  /**
   * 调用 /embeddings 接口
   */
  async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.isModelLoaded('embedding')) {
      throw new Error('Embedding model not loaded')
    }

    const response = await fetch(`${this.getBaseUrl()}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Embeddings API error: ${response.status} ${error}`)
    }

    return response.json() as Promise<EmbeddingResponse>
  }

  /**
   * 调用 /v1/chat/completions 接口
   */
  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!this.isModelLoaded('caption')) {
      throw new Error('Caption model not loaded')
    }

    const response = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Chat completion API error: ${response.status} ${error}`)
    }

    return response.json() as Promise<ChatCompletionResponse>
  }
}

// 单例
let serverManager: LlamaServerManager | null = null

export function getLlamaServerManager(userDataPath?: string): LlamaServerManager {
  if (!serverManager) {
    if (!userDataPath) {
      throw new Error('userDataPath required for first initialization')
    }
    serverManager = new LlamaServerManager(userDataPath)
  }
  return serverManager
}
