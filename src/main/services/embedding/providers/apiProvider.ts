/**
 * 远程 API 后端的 Embedding Provider
 * 支持多模态 embedding API（如 Qwen3-VL-Embedding）
 *
 * 使用 OpenAI chat messages 格式，支持图片和文本混合输入
 */

import type { EmbeddingProvider, EmbeddingInput, ApiProviderConfig } from '../types'
import { EMBEDDING_DIMENSIONS } from '../types'

interface EmbeddingResponse {
  data: Array<{
    embedding: number[]
    index: number
  }>
  model: string
  usage?: {
    prompt_tokens: number
    total_tokens: number
  }
}

// OpenAI chat message 格式
interface ChatMessage {
  role: 'user' | 'system'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >
}

export class ApiEmbeddingProvider implements EmbeddingProvider {
  private config: ApiProviderConfig
  private dimension: number = EMBEDDING_DIMENSIONS.QWEN3_VL_EMBEDDING
  private ready = false

  constructor(config: ApiProviderConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    this.ready = true
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    const messages = this.formatAsMessages(input)
    const response = await this.callApi(messages)

    if (!response.data || response.data.length === 0) {
      throw new Error('Empty embedding response from API')
    }

    return this.normalize(new Float32Array(response.data[0].embedding))
  }

  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    // 批量处理：逐个调用（messages 格式不支持批量）
    const results: Float32Array[] = []
    for (const input of inputs) {
      const embedding = await this.encode(input)
      results.push(embedding)
    }
    return results
  }

  getDimension(): number {
    return this.dimension
  }

  isReady(): boolean {
    return this.ready
  }

  async dispose(): Promise<void> {
    this.ready = false
  }

  /**
   * 调用 API（使用 messages 格式）
   */
  private async callApi(messages: ChatMessage[]): Promise<EmbeddingResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const body: Record<string, unknown> = {
      messages,
      encoding_format: 'float',
    }
    if (this.config.model) {
      body.model = this.config.model
    }

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`API error: ${response.status} ${error}`)
    }

    return response.json() as Promise<EmbeddingResponse>
  }

  /**
   * 将输入转换为 OpenAI chat messages 格式
   */
  private formatAsMessages(input: EmbeddingInput): ChatMessage[] {
    const content: ChatMessage['content'] = []

    switch (input.type) {
      case 'text':
        content.push({ type: 'text', text: input.content })
        break

      case 'image': {
        const base64 = input.content.toString('base64')
        const mimeType = this.detectMimeType(input.content)
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` },
        })
        break
      }

      case 'mixed': {
        const base64 = input.image.toString('base64')
        const mimeType = this.detectMimeType(input.image)
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` },
        })
        content.push({ type: 'text', text: input.text })
        break
      }
    }

    return [{ role: 'user', content }]
  }

  /**
   * 检测图片 MIME 类型
   */
  private detectMimeType(buffer: Buffer): string {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
    if (buffer[8] === 0x57 && buffer[9] === 0x45) return 'image/webp'
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif'
    return 'image/jpeg'
  }

  /**
   * L2 归一化
   */
  private normalize(vec: Float32Array): Float32Array {
    let norm = 0
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i]
    }
    norm = Math.sqrt(norm)

    if (norm === 0) return vec

    const normalized = new Float32Array(vec.length)
    for (let i = 0; i < vec.length; i++) {
      normalized[i] = vec[i] / norm
    }
    return normalized
  }
}
