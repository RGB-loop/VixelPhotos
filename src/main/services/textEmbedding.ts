import { pipeline, env } from '@huggingface/transformers'
import { app } from 'electron'
import { join } from 'path'

// 配置 transformers.js 缓存目录
env.cacheDir = join(app.getPath('userData'), 'models', 'transformers')
env.allowLocalModels = true
env.useBrowserCache = false

export class TextEmbedding {
  private extractor: any = null
  private isLoading = false
  private loadPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.extractor) return
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = this._init()
    return this.loadPromise
  }

  private async _init(): Promise<void> {
    if (this.isLoading) return
    this.isLoading = true

    try {
      console.log('Loading text embedding model...')

      // 使用 BAAI/bge-small-zh-v1.5 作为中文友好的小型模型
      // 或 Xenova/multilingual-e5-small 多语言模型
      this.extractor = await pipeline(
        'feature-extraction',
        'Xenova/multilingual-e5-small',
        {
          quantized: true, // 使用量化版本减少内存
        }
      )

      console.log('Text embedding model loaded successfully')
    } finally {
      this.isLoading = false
    }
  }

  /**
   * 生成文本 embedding
   */
  async encode(text: string): Promise<Float32Array> {
    await this.init()

    if (!this.extractor) {
      throw new Error('Model not loaded')
    }

    // E5 模型需要添加 "query: " 前缀
    const prefixedText = `query: ${text}`

    const output = await this.extractor(prefixedText, {
      pooling: 'mean',
      normalize: true,
    })

    // output.data 是 Float32Array
    return new Float32Array(output.data)
  }

  /**
   * 批量生成 embedding
   */
  async encodeBatch(texts: string[]): Promise<Float32Array[]> {
    await this.init()

    if (!this.extractor) {
      throw new Error('Model not loaded')
    }

    const prefixedTexts = texts.map((t) => `passage: ${t}`)

    const outputs = await this.extractor(prefixedTexts, {
      pooling: 'mean',
      normalize: true,
    })

    // 转换输出
    const results: Float32Array[] = []
    const dim = this.getDimension()

    for (let i = 0; i < texts.length; i++) {
      const start = i * dim
      const embedding = new Float32Array(dim)
      for (let j = 0; j < dim; j++) {
        embedding[j] = outputs.data[start + j]
      }
      results.push(embedding)
    }

    return results
  }

  /**
   * 为文档/段落生成 embedding（与 query 有细微区别）
   */
  async encodePassage(text: string): Promise<Float32Array> {
    await this.init()

    if (!this.extractor) {
      throw new Error('Model not loaded')
    }

    const prefixedText = `passage: ${text}`

    const output = await this.extractor(prefixedText, {
      pooling: 'mean',
      normalize: true,
    })

    return new Float32Array(output.data)
  }

  /**
   * 获取 embedding 维度
   */
  getDimension(): number {
    return 384 // multilingual-e5-small 输出维度
  }

  async dispose(): Promise<void> {
    this.extractor = null
  }
}

// 单例
let textEmbedding: TextEmbedding | null = null

export function getTextEmbedding(): TextEmbedding {
  if (!textEmbedding) {
    textEmbedding = new TextEmbedding()
  }
  return textEmbedding
}
