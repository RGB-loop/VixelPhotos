/**
 * llama-server 管理相关类型定义
 */

export type ModelType = 'embedding' | 'caption'

export interface ModelConfig {
  type: ModelType
  modelPath: string
  mmprojPath?: string // 视觉模型需要
  contextSize?: number
  // embedding 模型特有配置
  embeddingMode?: boolean
  poolingType?: 'mean' | 'last' | 'cls'
}

export interface LlamaServerConfig {
  port: number
  host: string
  models: {
    embedding: ModelConfig
    caption: ModelConfig
  }
}

export interface EmbeddingRequest {
  input: string | string[]
  // 图片以 base64 data URI 格式嵌入到 input 中
}

export interface EmbeddingResponse {
  data: Array<{
    embedding: number[]
    index: number
  }>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

export interface ChatCompletionRequest {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string | Array<{
      type: 'text' | 'image_url'
      text?: string
      image_url?: { url: string }
    }>
  }>
  max_tokens?: number
  temperature?: number
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string
      content: string
      // Qwen3.5 thinking 模型会在这里返回思考内容
      reasoning_content?: string
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
