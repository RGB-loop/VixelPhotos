/**
 * Embedding 服务
 *
 * 默认：本地 ONNX (SigLIP 2 base/16-256)，零网络。
 * 可选：外部 OpenAI 兼容 API（用户在 Settings 显式配置后启用）。
 *
 * 配置文件：<userData>/embedding-config.json
 * 形如：
 *   { "type": "onnx-local" }                           // 默认
 *   { "type": "api", "endpoint": "...", "apiKey": ... } // 显式切到 API
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingInput,
  OnnxProviderConfig,
  ApiProviderConfig,
} from './types'
import { ApiEmbeddingProvider } from './providers/apiProvider'
import { OnnxEmbeddingProvider } from './providers/onnxProvider'

export * from './types'

// 模块级状态
let _userDataPath: string = ''
let _bundledModelsDir: string = ''

export function initEmbeddingServicePath(
  userDataPath: string,
  bundledModelsDir?: string
): void {
  _userDataPath = userDataPath
  if (bundledModelsDir) _bundledModelsDir = bundledModelsDir
}

function getConfigPath(): string {
  return join(_userDataPath, 'embedding-config.json')
}

function loadConfig(): EmbeddingProviderConfig {
  const configPath = getConfigPath()
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (raw && raw.type === 'api' && raw.endpoint) {
        return { ...raw, type: 'api' as const } as ApiProviderConfig
      }
      // 'onnx-local' 或缺省都视作本地
    } catch (err) {
      console.warn('Failed to parse embedding-config.json, falling back to onnx-local:', err)
    }
  }

  // 默认：本地 ONNX，模型目录用打包资源目录
  return {
    type: 'onnx-local',
    modelsDir: _bundledModelsDir,
  }
}

function saveConfig(config: EmbeddingProviderConfig): void {
  const configPath = getConfigPath()
  // 只把用户能调整的字段写盘；modelsDir 等运行时字段不持久化
  const persistable =
    config.type === 'api'
      ? { type: 'api', endpoint: config.endpoint, apiKey: config.apiKey, model: config.model }
      : { type: 'onnx-local' }
  writeFileSync(configPath, JSON.stringify(persistable, null, 2))
}

class EmbeddingService {
  private provider: EmbeddingProvider | null = null
  private config: EmbeddingProviderConfig
  private initError: string | null = null

  constructor() {
    this.config = loadConfig()
  }

  /**
   * 切换 API 配置（设置后保存并重建 provider）
   */
  setApiConfig(config: Omit<ApiProviderConfig, 'type'>): void {
    this.config = { type: 'api', ...config }
    saveConfig(this.config)
    this.initError = null
    if (this.provider) {
      this.provider.dispose()
      this.provider = null
    }
  }

  /**
   * 切回默认（本地 ONNX）
   */
  useLocal(): void {
    this.config = { type: 'onnx-local', modelsDir: _bundledModelsDir }
    saveConfig(this.config)
    this.initError = null
    if (this.provider) {
      this.provider.dispose()
      this.provider = null
    }
  }

  getConfig(): EmbeddingProviderConfig {
    return this.config
  }

  isConfigured(): boolean {
    if (this.config.type === 'onnx-local') {
      // 本地模型只要目录存在就算"已配置"
      const modelsDir = this.config.modelsDir || _bundledModelsDir
      return !!modelsDir
    }
    return !!this.config.endpoint
  }

  getInitError(): string | null {
    return this.initError
  }

  async init(): Promise<void> {
    if (!this.isConfigured()) {
      this.initError = 'Embedding provider not configured'
      return
    }

    try {
      if (!this.provider) {
        this.provider = this.createProvider()
      }
      await this.provider.init()
      this.initError = null
      console.log(`Embedding service initialized with provider: ${this.config.type}`)
    } catch (error) {
      this.initError = String(error)
      console.error('Embedding service init failed:', error)
    }
  }

  private createProvider(): EmbeddingProvider {
    if (this.config.type === 'api') {
      return new ApiEmbeddingProvider(this.config)
    }
    const modelsDir = this.config.modelsDir || _bundledModelsDir
    return new OnnxEmbeddingProvider({
      type: 'onnx-local',
      modelsDir,
      modelDirName: (this.config as OnnxProviderConfig).modelDirName,
      quantized: (this.config as OnnxProviderConfig).quantized,
      device: (this.config as OnnxProviderConfig).device,
    })
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    await this.ensureInitialized()
    if (!this.provider) {
      throw new Error(this.initError || 'Embedding service not available')
    }
    return this.provider.encode(input)
  }

  async encodeText(text: string): Promise<Float32Array> {
    return this.encode({ type: 'text', content: text })
  }

  async encodeImage(imageBuffer: Buffer): Promise<Float32Array> {
    return this.encode({ type: 'image', content: imageBuffer })
  }

  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    await this.ensureInitialized()
    if (!this.provider) {
      throw new Error(this.initError || 'Embedding service not available')
    }
    return this.provider.encodeBatch(inputs)
  }

  getDimension(): number {
    return this.provider?.getDimension() ?? 768
  }

  isReady(): boolean {
    return this.provider?.isReady() ?? false
  }

  async dispose(): Promise<void> {
    if (this.provider) {
      await this.provider.dispose()
      this.provider = null
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.provider && this.isConfigured()) {
      await this.init()
    }
  }
}

let embeddingService: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingService) {
    embeddingService = new EmbeddingService()
  }
  return embeddingService
}
