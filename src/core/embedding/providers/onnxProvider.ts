/**
 * 本地 ONNX Embedding Provider — SigLIP 2 base/16-256
 *
 * 视觉端与文本端共享同一嵌入空间，可以直接 dot-product 做图文检索。
 * 模型由 @huggingface/transformers 加载，底层走 onnxruntime-node。
 *
 * 模型文件位置：<modelsDir>/siglip2/
 *   ├─ config.json
 *   ├─ tokenizer.json
 *   ├─ tokenizer_config.json
 *   ├─ preprocessor_config.json
 *   └─ onnx/
 *       ├─ model.onnx                       (vision + text 合一模型)
 *       └─ model_quantized.onnx (optional)
 *
 * 通过 `scripts/download-models.mjs` 拉取，或参考 README 的 setup 章节。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import type { EmbeddingProvider, EmbeddingInput, OnnxProviderConfig } from '../types'
import { EMBEDDING_DIMENSIONS } from '../types'

// transformers.js 体型很大，按需 require 避免拖慢冷启动
type TransformersModule = typeof import('@huggingface/transformers')

let transformersPromise: Promise<TransformersModule> | null = null
function loadTransformers(): Promise<TransformersModule> {
  if (!transformersPromise) {
    transformersPromise = import('@huggingface/transformers')
  }
  return transformersPromise
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  private config: OnnxProviderConfig
  private tokenizer: any = null
  private processor: any = null
  private model: any = null
  private ready = false

  constructor(config: OnnxProviderConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    if (this.ready) return

    const { AutoTokenizer, AutoProcessor, AutoModel, env } =
      await loadTransformers()

    // 关闭远程下载，强制使用本地模型
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = this.config.modelsDir

    const modelDirName = this.config.modelDirName || 'siglip2'
    const modelDir = join(this.config.modelsDir, modelDirName)
    if (!existsSync(modelDir)) {
      throw new Error(
        `SigLIP 2 model not found at ${modelDir}. ` +
        `Run \`node scripts/download-models.mjs\` or see README for setup.`
      )
    }

    // 优先 quantized；否则 fp32
    const dtype = this.config.quantized === false ? 'fp32' : 'q8'

    this.tokenizer = await AutoTokenizer.from_pretrained(modelDirName)
    this.processor = await AutoProcessor.from_pretrained(modelDirName)
    this.model = await AutoModel.from_pretrained(modelDirName, {
      dtype,
      device: this.config.device || 'cpu',
    })

    this.ready = true
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    if (!this.ready) throw new Error('OnnxEmbeddingProvider not initialized')

    if (input.type === 'text') {
      return this.encodeText(input.content)
    }
    if (input.type === 'image') {
      return this.encodeImage(input.content)
    }
    // mixed: 简化为图像 embedding（搜索场景几乎用不到 mixed）
    return this.encodeImage(input.image)
  }

  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    // 暂以串行实现保持简单；后续可针对纯文本/纯图像批量
    const out: Float32Array[] = []
    for (const inp of inputs) out.push(await this.encode(inp))
    return out
  }

  getDimension(): number {
    return EMBEDDING_DIMENSIONS.SIGLIP2_BASE
  }

  isReady(): boolean {
    return this.ready
  }

  async dispose(): Promise<void> {
    this.tokenizer = null
    this.processor = null
    this.model = null
    this.ready = false
  }

  // ---------- 内部 ----------

  private async encodeText(text: string): Promise<Float32Array> {
    const { Tensor } = await loadTransformers()
    void Tensor
    const inputs = this.tokenizer(text, {
      padding: 'max_length',
      truncation: true,
    })
    // SigLIP/CLIP-style 模型对外暴露 get_text_features
    const out = await this.model.get_text_features(inputs)
    return this.normalize(out.data as Float32Array)
  }

  private async encodeImage(imageBuffer: Buffer): Promise<Float32Array> {
    const { RawImage } = await loadTransformers()
    // Buffer → 独立 ArrayBuffer（Node Buffer 类型上是 SharedArrayBuffer | ArrayBuffer，
    // 显式拷一份 ArrayBuffer 给 Blob 即可消歧）
    const ab = new ArrayBuffer(imageBuffer.byteLength)
    new Uint8Array(ab).set(imageBuffer)
    const blob = new Blob([ab])
    const image = await RawImage.read(blob)
    const inputs = await this.processor(image)
    const out = await this.model.get_image_features(inputs)
    return this.normalize(out.data as Float32Array)
  }

  private normalize(vec: Float32Array): Float32Array {
    let norm = 0
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    if (norm === 0) return vec
    const out = new Float32Array(vec.length)
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm
    return out
  }
}
