/**
 * llama-server 后端的 Embedding Provider
 * 使用 Qwen3-VL-Embedding 模型
 */

import type { EmbeddingProvider, EmbeddingInput } from '../types'
import { EMBEDDING_DIMENSIONS } from '../types'
import { getLlamaServerManager } from '../../llama/serverManager'

export class LlamaEmbeddingProvider implements EmbeddingProvider {
  private dimension: number = EMBEDDING_DIMENSIONS.QWEN3_VL_EMBEDDING
  private ready = false

  async init(): Promise<void> {
    const manager = getLlamaServerManager()

    // 确保 embedding 模型已加载
    await manager.ensureModel('embedding')
    this.ready = true
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    const manager = getLlamaServerManager()
    await manager.ensureModel('embedding')

    const prompt = this.formatInput(input)

    const response = await manager.embeddings({
      input: prompt,
    })

    if (!response.data || response.data.length === 0) {
      throw new Error('Empty embedding response')
    }

    const embedding = new Float32Array(response.data[0].embedding)

    // 归一化
    return this.normalize(embedding)
  }

  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    const manager = getLlamaServerManager()
    await manager.ensureModel('embedding')

    const prompts = inputs.map((input) => this.formatInput(input))

    const response = await manager.embeddings({
      input: prompts,
    })

    return response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => this.normalize(new Float32Array(item.embedding)))
  }

  getDimension(): number {
    return this.dimension
  }

  isReady(): boolean {
    return this.ready && getLlamaServerManager().isModelLoaded('embedding')
  }

  async dispose(): Promise<void> {
    this.ready = false
  }

  /**
   * 格式化输入为 llama-server 接受的格式
   * 图片使用 base64 data URI
   */
  private formatInput(input: EmbeddingInput): string {
    switch (input.type) {
      case 'text':
        return input.content

      case 'image': {
        // 转换为 base64 data URI
        const base64 = input.content.toString('base64')
        // 简单判断图片类型
        const mimeType = this.detectMimeType(input.content)
        return `![image](data:${mimeType};base64,${base64})`
      }

      case 'mixed': {
        const base64 = input.image.toString('base64')
        const mimeType = this.detectMimeType(input.image)
        // 混合输入：文本 + 图片
        return `${input.text}\n![image](data:${mimeType};base64,${base64})`
      }
    }
  }

  /**
   * 检测图片 MIME 类型
   */
  private detectMimeType(buffer: Buffer): string {
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
      return 'image/png'
    }
    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return 'image/jpeg'
    }
    // WebP
    if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp'
    }
    // GIF
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return 'image/gif'
    }
    // 默认 JPEG
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
