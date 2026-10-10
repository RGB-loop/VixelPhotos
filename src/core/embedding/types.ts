/**
 * 统一的 Embedding 接口定义
 * 支持文本、图片、音频、视频（EmbeddingGemma 2 多模态）
 */

export type EmbeddingInputType = 'text' | 'image' | 'audio' | 'video' | 'multimodal'

export interface TextInput {
  type: 'text'
  content: string
}

export interface ImageInput {
  type: 'image'
  content: Buffer
}

export interface AudioInput {
  type: 'audio'
  /** mono 16kHz Float32Array（送入前封装成 WAV） */
  samples: Float32Array
}

export interface VideoInput {
  type: 'video'
  /** 帧序列（JPEG），一次推理融合成一个片段向量 */
  frames: Buffer[]
  /** 片段时长（秒） */
  durationSec: number
}

export interface MultimodalInput {
  type: 'multimodal'
  text?: string
  image?: Buffer
  audio?: Float32Array
  video?: { frames: Buffer[]; durationSec: number }
}

export type EmbeddingInput = TextInput | ImageInput | AudioInput | VideoInput | MultimodalInput

/**
 * Embedding Provider 接口
 */
export interface EmbeddingProvider {
  init(): Promise<void>
  encode(input: EmbeddingInput): Promise<Float32Array>
  encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]>
  getDimension(): number
  isReady(): boolean
  dispose(): Promise<void>
}

/**
 * EmbeddingGemma 2 经 LiteRT-LM 推理（官方 .litertlm）：768 维，文本 / 图像 / 音频 / 视频同一空间。
 * GPU 优先（macOS Metal，Windows WebGPU → D3D12），不可用时 CPU。
 */
export interface LiteRtProviderConfig {
  type: 'litert'
  modelsDir: string             // 模型根目录（包含 litert/<model>.litertlm）
  libDir: string                // LiteRT-LM 原生库所在目录（resources/litert/<platform>-<arch>）
  backend?: 'auto' | 'gpu' | 'cpu'  // 默认 auto：GPU 优先，失败退 CPU
  cacheDir?: string             // GPU 着色器编译缓存（首次 ~7 s，之后启动更快）
}

export type EmbeddingProviderConfig = LiteRtProviderConfig

/**
 * 向量维度常量
 */
export const EMBEDDING_DIMENSIONS = {
  GEMMA2_BASE: 768,        // EmbeddingGemma 2 基础输出
  GEMMA2_MRL_512: 512,     // Matryoshka 截断
  GEMMA2_MRL_256: 256,
  GEMMA2_MRL_128: 128,
} as const
