import { pipeline, env, RawImage } from '@huggingface/transformers'
import { app } from 'electron'
import { join } from 'path'
import sharp from 'sharp'

// 配置 transformers.js 缓存目录
env.cacheDir = join(app.getPath('userData'), 'models', 'transformers')
env.allowLocalModels = true
env.useBrowserCache = false

export class ImageEmbedding {
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
      console.log('Loading image embedding model...')

      // 使用 CLIP 模型进行图像特征提取
      // Xenova/clip-vit-base-patch32 是一个较小的模型，适合端侧运行
      this.extractor = await pipeline(
        'image-feature-extraction',
        'Xenova/clip-vit-base-patch32',
        {
          quantized: true,
        }
      )

      console.log('Image embedding model loaded successfully')
    } catch (error) {
      console.error('Failed to load image embedding model:', error)
      throw error
    } finally {
      this.isLoading = false
    }
  }

  /**
   * 生成图像 embedding
   */
  async encode(imageBuffer: Buffer): Promise<Float32Array> {
    await this.init()

    if (!this.extractor) {
      throw new Error('Model not loaded')
    }

    try {
      // 调整图像大小并转换为 RGB
      const { data, info } = await sharp(imageBuffer)
        .resize(224, 224, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

      // 创建 RawImage 对象
      const rawImage = new RawImage(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
        info.channels
      )

      // 生成 embedding
      const output = await this.extractor(rawImage, {
        pooling: 'mean',
        normalize: true,
      })

      return new Float32Array(output.data)
    } catch (error) {
      console.error('Image embedding failed:', error)
      throw error
    }
  }

  /**
   * 批量生成 embedding
   */
  async encodeBatch(imageBuffers: Buffer[]): Promise<Float32Array[]> {
    const results: Float32Array[] = []
    for (const buffer of imageBuffers) {
      results.push(await this.encode(buffer))
    }
    return results
  }

  /**
   * 获取 embedding 维度
   */
  getDimension(): number {
    return 512 // CLIP ViT-B/32 输出维度
  }

  async dispose(): Promise<void> {
    this.extractor = null
  }
}

// 单例
let imageEmbedding: ImageEmbedding | null = null

export function getImageEmbedding(): ImageEmbedding {
  if (!imageEmbedding) {
    imageEmbedding = new ImageEmbedding()
  }
  return imageEmbedding
}
