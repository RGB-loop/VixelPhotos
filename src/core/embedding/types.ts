/**
 * 统一的 Embedding 接口定义
 * 支持文本、图片、混合输入
 */

export type EmbeddingInputType = 'text' | 'image' | 'mixed'

export interface TextInput {
  type: 'text'
  content: string
}

export interface ImageInput {
  type: 'image'
  content: Buffer
}

export interface MixedInput {
  type: 'mixed'
  text: string
  image: Buffer
}

export type EmbeddingInput = TextInput | ImageInput | MixedInput

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
 *  - `onnx-local`（默认）：本地 ONNX，SigLIP 2 base/16-256，零网络
 *  - `api`：外部 OpenAI 兼容多模态 API（可选/兜底）
 */
export type ProviderType = 'onnx-local' | 'api'

export interface OnnxProviderConfig {
  type: 'onnx-local'
  modelsDir: string             // 模型根目录（包含 siglip2/ 子目录）
  modelDirName?: string         // 默认 'siglip2'
  quantized?: boolean           // 默认 true（q8 量化），false 用 fp32
  device?: 'cpu' | 'webgpu'     // 默认 cpu
}

export interface ApiProviderConfig {
  type: 'api'
  endpoint: string
  apiKey?: string
  model?: string
}

export type EmbeddingProviderConfig =
  | OnnxProviderConfig
  | ApiProviderConfig

/**
 * 向量维度常量
 */
export const EMBEDDING_DIMENSIONS = {
  SIGLIP2_BASE: 768,
  SIGLIP2_LARGE: 1024,
  CLIP_BASE: 512,
  // legacy（API 后端用过的）
  QWEN3_VL_EMBEDDING: 2048,
} as const
