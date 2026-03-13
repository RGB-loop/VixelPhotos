import sharp from 'sharp'
import { getLlamaServer } from './llamaServer'

export class CaptionGenerator {
  private isInitialized = false
  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.isInitialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._init()
    return this.initPromise
  }

  private async _init(): Promise<void> {
    console.log('Initializing caption generator with Qwen3-VL-4B...')

    const server = getLlamaServer()

    // 检查模型文件
    const models = server.checkModels()
    if (!models.model || !models.mmproj) {
      console.warn(
        'Qwen3-VL-4B model files not found. Caption generation will be disabled. ' +
          `Please download models to: ${server.getModelsDir()}`
      )
      return
    }

    try {
      await server.start()
      this.isInitialized = true
      console.log('Caption generator initialized successfully')
    } catch (error) {
      console.error('Failed to initialize caption generator:', error)
      throw error
    }
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    return this.isInitialized && getLlamaServer().isServerReady()
  }

  /**
   * 为图片生成描述
   */
  async generate(imageBuffer: Buffer): Promise<string> {
    if (!this.isAvailable()) {
      console.warn('Caption generator not available')
      return ''
    }

    try {
      // 调整图像大小并转换为 JPEG
      const resized = await sharp(imageBuffer)
        .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()

      const base64Image = resized.toString('base64')

      const server = getLlamaServer()
      const baseUrl = server.getBaseUrl()

      // 使用 OpenAI 兼容的 API 格式
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3-vl-4b',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`,
                  },
                },
                {
                  type: 'text',
                  text: 'Describe this image in one detailed sentence. Focus on the main subjects, actions, and setting. Be concise but descriptive.',
                },
              ],
            },
          ],
          max_tokens: 150,
          temperature: 0.7,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Caption API error:', errorText)
        return ''
      }

      const data = await response.json()

      if (data.choices && data.choices.length > 0) {
        const caption = data.choices[0].message?.content || ''
        // 清理可能的思考标签
        return this.cleanCaption(caption)
      }

      return ''
    } catch (error) {
      console.error('Caption generation failed:', error)
      return ''
    }
  }

  /**
   * 清理 caption 文本
   */
  private cleanCaption(text: string): string {
    // 移除可能的 <think>...</think> 标签
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '')

    // 移除多余空白
    cleaned = cleaned.trim()

    // 如果结果为空，返回原始文本
    if (!cleaned && text) {
      cleaned = text.trim()
    }

    return cleaned
  }

  /**
   * 批量生成描述
   */
  async generateBatch(imageBuffers: Buffer[]): Promise<string[]> {
    const results: string[] = []
    for (const buffer of imageBuffers) {
      const caption = await this.generate(buffer)
      results.push(caption)
    }
    return results
  }

  /**
   * 重新初始化（用于模型下载完成后）
   */
  async reinit(): Promise<void> {
    this.isInitialized = false
    this.initPromise = null
    await this.init()
  }

  async dispose(): Promise<void> {
    // 服务器由 llamaServer 单例管理，这里不需要停止
  }
}

// 单例
let captionGenerator: CaptionGenerator | null = null

export function getCaptionGenerator(): CaptionGenerator {
  if (!captionGenerator) {
    captionGenerator = new CaptionGenerator()
  }
  return captionGenerator
}
