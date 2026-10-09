/**
 * Embedding 服务
 *
 * EmbeddingGemma 2 多模态本地推理（文本/图像/音频/视频，768 维）
 * 纯本地，零网络依赖。
 *
 * 配置文件：<userData>/embedding-config.json
 * 形如：
 *   { "type": "gemma2-local" }  // 默认
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingInput,
  Gemma2ProviderConfig,
} from './types'
import { Gemma2EmbeddingProvider } from './providers/gemma2Provider'
import { RemoteEmbeddingProvider } from './providers/remoteProvider'
import { getInferenceTransport } from '../inference/transport'

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
      if (raw && raw.type === 'gemma2-local') {
        return {
          type: 'gemma2-local',
          modelsDir: _bundledModelsDir,
          textQuantization: raw.textQuantization,
          visionQuantization: raw.visionQuantization,
          audioQuantization: raw.audioQuantization,
          device: raw.device,
        } as Gemma2ProviderConfig
      }
    } catch (err) {
      console.warn('Failed to parse embedding-config.json, using defaults:', err)
    }
  }

  // 默认：EmbeddingGemma 2，文本/视觉 q4，音频 q8
  return {
    type: 'gemma2-local',
    modelsDir: _bundledModelsDir,
    textQuantization: 'q4',
    visionQuantization: 'q4',
    audioQuantization: 'q8',
    device: 'cpu',
  }
}

function saveConfig(config: EmbeddingProviderConfig): void {
  const configPath = getConfigPath()
  // 只把用户能调整的字段写盘；modelsDir 等运行时字段不持久化
  const persistable = {
    type: 'gemma2-local',
    textQuantization: config.textQuantization,
    visionQuantization: config.visionQuantization,
    audioQuantization: config.audioQuantization,
    device: config.device,
  }
  writeFileSync(configPath, JSON.stringify(persistable, null, 2))
}

class EmbeddingService {
  private provider: EmbeddingProvider | null = null
  private config: EmbeddingProviderConfig
  private initError: string | null = null

  constructor() {
    this.config = loadConfig()
  }

  getConfig(): EmbeddingProviderConfig {
    return this.config
  }

  isConfigured(): boolean {
    // 纯本地，只要模型目录存在就算已配置
    const modelsDir = this.config.modelsDir || _bundledModelsDir
    return !!modelsDir
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
    const modelsDir = this.config.modelsDir || _bundledModelsDir
    const config: Gemma2ProviderConfig = {
      type: 'gemma2-local',
      modelsDir,
      modelDirName: this.config.modelDirName,
      textQuantization: this.config.textQuantization,
      visionQuantization: this.config.visionQuantization,
      audioQuantization: this.config.audioQuantization,
      device: this.config.device,
    }
    const transport = getInferenceTransport()
    return transport ? new RemoteEmbeddingProvider(transport, config) : new Gemma2EmbeddingProvider(config)
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

  /** mono 16kHz Float32Array（见 src/core/audio/extract.ts） */
  async encodeAudio(samples: Float32Array): Promise<Float32Array> {
    return this.encode({ type: 'audio', samples })
  }

  /** 帧序列 → 单个片段向量。processor 最多取 32 帧（超出均匀降采样）。 */
  async encodeVideo(frames: Buffer[], durationSec: number): Promise<Float32Array> {
    return this.encode({ type: 'video', frames, durationSec })
  }

  /**
   * 调整量化档位 / 推理设备。写盘并重建 provider（下次 encode 时懒加载）。
   */
  setConfig(patch: Partial<Omit<Gemma2ProviderConfig, 'type' | 'modelsDir'>>): void {
    this.config = { ...this.config, ...patch }
    saveConfig(this.config)
    this.initError = null
    if (this.provider) {
      this.provider.dispose()
      this.provider = null
    }
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
