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
  /** mono 16kHz Float32Array，符合 Gemma 2 audio encoder 要求 */
  samples: Float32Array
}

export interface VideoInput {
  type: 'video'
  /** 帧序列（processor max_frames = 32，超出均匀降采样），RawImage[] 或 Buffer[] */
  frames: Buffer[]
  /** 视频时长（秒），用于 RawVideo 构造 */
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
 * Provider 类型
 *  - `gemma2-local`：本地 ONNX，EmbeddingGemma 2 (768D，多模态：文本/图像/音频/视频)
 */
export type ProviderType = 'gemma2-local'

export interface Gemma2ProviderConfig {
  type: 'gemma2-local'
  modelsDir: string             // 模型根目录（包含 gemma2/ 子目录）
  modelDirName?: string         // 默认 'gemma2'
  /**
   * 量化档位：
   *  - text/vision: q4 (默认，284MB)
   *  - audio: q8 (默认，340MB，官方建议)
   */
  textQuantization?: 'q4' | 'q8' | 'fp32'
  visionQuantization?: 'q4' | 'q8' | 'fp32'
  audioQuantization?: 'q8' | 'q4' | 'fp32'
  device?: 'cpu' | 'webgpu'     // 默认 cpu
}

export type EmbeddingProviderConfig = Gemma2ProviderConfig

/**
 * 向量维度常量
 */
export const EMBEDDING_DIMENSIONS = {
  GEMMA2_BASE: 768,        // EmbeddingGemma 2 基础输出
  GEMMA2_MRL_512: 512,     // Matryoshka 截断
  GEMMA2_MRL_256: 256,
  GEMMA2_MRL_128: 128,
} as const
