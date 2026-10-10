/**
 * Embedding 服务
 *
 * EmbeddingGemma 2 多模态本地推理（文本/图像/音频/视频，768 维），经 LiteRT-LM，纯本地，零网络依赖。
 *
 * 配置文件：<userData>/embedding-config.json，只存用户可调的项：
 *   { "backend": "auto" }    // auto | gpu | cpu
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingInput,
  LiteRtProviderConfig,
} from './types'
import { LiteRtEmbeddingProvider, LITERT_MODEL_FILE } from './providers/litert/litertProvider'
import { LITERT_LIB_NAME } from './providers/litert/native'
import { RemoteEmbeddingProvider } from './providers/remoteProvider'
import { getInferenceTransport } from '../inference/transport'

export * from './types'

// 模块级状态
let _userDataPath: string = ''
let _bundledModelsDir: string = ''
let _litertLibDir: string = ''

/**
 * @param litertLibDir LiteRT-LM 原生库目录（打包后 <resources>/litert，开发时 resources/litert/<platform>-<arch>）
 */
export function initEmbeddingServicePath(
  userDataPath: string,
  bundledModelsDir?: string,
  litertLibDir?: string
): void {
  _userDataPath = userDataPath
  if (bundledModelsDir) _bundledModelsDir = bundledModelsDir
  if (litertLibDir) _litertLibDir = litertLibDir
}

/** LiteRT 运行时 + 模型是否都在 */
export function isLiteRtInstalled(): boolean {
  const lib = LITERT_LIB_NAME[process.platform]
  return !!lib && !!_litertLibDir && existsSync(join(_litertLibDir, lib)) &&
    existsSync(join(_bundledModelsDir, 'litert', LITERT_MODEL_FILE))
}

function getConfigPath(): string {
  return join(_userDataPath, 'embedding-config.json')
}

function readPersisted(): Record<string, unknown> {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (err) {
    console.warn('Failed to parse embedding-config.json, using defaults:', err)
    return {}
  }
}

function loadConfig(): EmbeddingProviderConfig {
  const raw = readPersisted()
  return {
    type: 'litert',
    modelsDir: _bundledModelsDir,
    libDir: _litertLibDir,
    backend: raw.backend === 'gpu' || raw.backend === 'cpu' ? raw.backend : 'auto',
    cacheDir: _userDataPath ? join(_userDataPath, 'litert-cache') : undefined,
  }
}

function saveConfig(config: EmbeddingProviderConfig): void {
  // 只把用户能调整的字段写盘；路径等运行时字段不持久化
  writeFileSync(getConfigPath(), JSON.stringify({ backend: config.backend ?? 'auto' }, null, 2))
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
    return isLiteRtInstalled()
  }

  getInitError(): string | null {
    return this.initError
  }

  async init(): Promise<void> {
    if (!this.isConfigured()) {
      this.initError = 'LiteRT runtime or EmbeddingGemma 2 model missing — run `npm run models:download`'
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
    const transport = getInferenceTransport()
    return transport ? new RemoteEmbeddingProvider(transport, this.config) : new LiteRtEmbeddingProvider(this.config)
  }

  /** 实际在用的推理后端（gpu / cpu），设置页展示用 */
  getActiveBackend(): string | null {
    if (!this.provider?.isReady()) return null
    return (this.provider as unknown as { activeBackend?: string | null }).activeBackend ?? null
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

  /** 调整推理后端偏好。写盘并重建 provider（下次 encode 时懒加载）。 */
  setConfig(patch: { backend?: LiteRtProviderConfig['backend'] }): void {
    if (patch.backend) this.config = { ...this.config, backend: patch.backend }
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
