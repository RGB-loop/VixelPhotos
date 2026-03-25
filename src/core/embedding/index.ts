/**
 * Embedding 服务
 * 使用外部 API 进行多模态 embedding（本地 llama embedding 暂不支持）
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingInput,
  ApiProviderConfig,
} from './types'
import { EMBEDDING_DIMENSIONS } from './types'
import { ApiEmbeddingProvider } from './providers/apiProvider'

export * from './types'

// 模块级路径，由 initEmbeddingServicePath() 设置
let _userDataPath: string = ''

export function initEmbeddingServicePath(userDataPath: string): void {
  _userDataPath = userDataPath
}

function getConfigPath(): string {
  return join(_userDataPath, 'embedding-config.json')
}

/**
 * 从文件加载配置
 */
function loadConfig(): ApiProviderConfig | null {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    return null
  }

  try {
    const content = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content) as ApiProviderConfig
    // 验证必要字段
    if (!config.endpoint) {
      console.warn('Embedding config missing endpoint')
      return null
    }
    return { ...config, type: 'api' as const }
  } catch (error) {
    console.error('Failed to load embedding config:', error)
    return null
  }
}

/**
 * 保存配置到文件
 */
function saveConfig(config: ApiProviderConfig): void {
  const configPath = getConfigPath()
  const { type, ...rest } = config
  writeFileSync(configPath, JSON.stringify(rest, null, 2))
}

/**
 * Embedding 服务单例
 */
class EmbeddingService {
  private provider: EmbeddingProvider | null = null
  private config: ApiProviderConfig | null = null
  private initError: string | null = null

  constructor() {
    // 尝试从配置文件加载
    this.config = loadConfig()
  }

  /**
   * 设置配置并保存
   */
  setConfig(config: Omit<ApiProviderConfig, 'type'>): void {
    this.config = { type: 'api', ...config }
    saveConfig(this.config)
    this.initError = null

    // 如果已有 provider，需要重新创建
    if (this.provider) {
      this.provider.dispose()
      this.provider = null
    }
  }

  /**
   * 获取配置
   */
  getConfig(): ApiProviderConfig | null {
    return this.config
  }

  /**
   * 检查是否已配置
   */
  isConfigured(): boolean {
    return this.config !== null && !!this.config.endpoint
  }

  /**
   * 获取初始化错误
   */
  getInitError(): string | null {
    return this.initError
  }

  /**
   * 初始化服务
   */
  async init(): Promise<void> {
    if (!this.isConfigured()) {
      this.initError = 'Embedding API not configured'
      console.log('Embedding service: API not configured, skipping init')
      return
    }

    try {
      if (!this.provider) {
        this.provider = new ApiEmbeddingProvider(this.config!)
      }
      await this.provider.init()
      this.initError = null
      console.log('Embedding service initialized with API:', this.config!.endpoint)
    } catch (error) {
      this.initError = String(error)
      console.error('Embedding service init failed:', error)
    }
  }

  /**
   * 编码单个输入
   */
  async encode(input: EmbeddingInput): Promise<Float32Array> {
    await this.ensureInitialized()
    if (!this.provider) {
      throw new Error(this.initError || 'Embedding service not available')
    }
    return this.provider.encode(input)
  }

  /**
   * 编码文本
   */
  async encodeText(text: string): Promise<Float32Array> {
    return this.encode({ type: 'text', content: text })
  }

  /**
   * 编码图片
   */
  async encodeImage(imageBuffer: Buffer): Promise<Float32Array> {
    return this.encode({ type: 'image', content: imageBuffer })
  }

  /**
   * 批量编码
   */
  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    await this.ensureInitialized()
    if (!this.provider) {
      throw new Error(this.initError || 'Embedding service not available')
    }
    return this.provider.encodeBatch(inputs)
  }

  /**
   * 获取向量维度
   */
  getDimension(): number {
    return this.provider?.getDimension() ?? EMBEDDING_DIMENSIONS.QWEN3_VL_EMBEDDING
  }

  /**
   * 检查是否就绪
   */
  isReady(): boolean {
    return this.provider?.isReady() ?? false
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    if (this.provider) {
      await this.provider.dispose()
      this.provider = null
    }
  }

  /**
   * 确保已初始化
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.provider && this.isConfigured()) {
      await this.init()
    }
  }
}

// 单例
let embeddingService: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingService) {
    embeddingService = new EmbeddingService()
  }
  return embeddingService
}
