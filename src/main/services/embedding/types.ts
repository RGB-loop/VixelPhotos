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
  /**
   * 初始化 provider
   */
  init(): Promise<void>

  /**
   * 生成 embedding
   */
  encode(input: EmbeddingInput): Promise<Float32Array>

  /**
   * 批量生成 embedding
   */
  encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]>

  /**
   * 获取向量维度
   */
  getDimension(): number

  /**
   * 检查是否就绪
   */
  isReady(): boolean

  /**
   * 释放资源
   */
  dispose(): Promise<void>
}

/**
 * Provider 配置
 */
export type ProviderType = 'llama' | 'api' | 'clip'

export interface LlamaProviderConfig {
  type: 'llama'
  // llama-server 由 serverManager 管理，这里不需要额外配置
}

export interface ApiProviderConfig {
  type: 'api'
  endpoint: string
  apiKey?: string  // 可选，某些本地 API 不需要
  model?: string   // 可选，某些 API 不需要指定
}

export interface ClipProviderConfig {
  type: 'clip'
  model: string // e.g., 'Xenova/clip-vit-base-patch32'
}

export type EmbeddingProviderConfig =
  | LlamaProviderConfig
  | ApiProviderConfig
  | ClipProviderConfig

/**
 * 默认配置 - 使用 API provider（本地 llama embedding 暂不支持）
 * 需要在 userData/embedding-config.json 中配置 API endpoint
 */
export const DEFAULT_EMBEDDING_CONFIG: ApiProviderConfig = {
  type: 'api',
  endpoint: '', // 需要配置
}

/**
 * 向量维度常量
 */
export const EMBEDDING_DIMENSIONS = {
  QWEN3_VL_EMBEDDING: 2048,
  QWEN3_VL_EMBEDDING_TRUNCATED: 512, // Matryoshka 截断
  CLIP_BASE: 512,
  CLIP_LARGE: 768,
} as const
