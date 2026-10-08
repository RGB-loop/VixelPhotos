/**
 * EmbeddingGemma 2 多模态 Embedding Provider
 *
 * 统一嵌入空间：文本、图像、音频、视频
 * 基于 Gemma 4 架构，740M 参数（文本 270M + 视觉 170M + 音频 300M）
 * 输出 768 维，支持 Matryoshka 截断到 512/256/128
 *
 * 模型文件位置：<modelsDir>/gemma2/
 *   ├─ config.json
 *   ├─ tokenizer.json
 *   ├─ preprocessor_config.json
 *   ├─ processor_config.json   (video_processor.max_frames = 32)
 *   └─ onnx/                   (每个 .onnx 配一个 .onnx_data 权重文件)
 *       ├─ model_q4.onnx                     (文本 + 融合, q4, 174MB)
 *       ├─ vision_encoder_q4.onnx            (q4, 109MB)
 *       └─ audio_encoder_quantized.onnx      (q8, 340MB)
 *
 * API 形态（单模型多模态，不是 CLIP 式双塔）：
 *   - 文本走 tokenizer → model；图像/音频/视频走 processor(text, images, audio, videos) → model
 *   - 输出均取 .sentence_embedding（mean-pool + L2 归一化）
 *   - 文本 query 需加任务前缀："task: query | text: <query>"
 *
 * 通过 @huggingface/transformers (≥4.3.1) + onnxruntime-node 加载。
 */

import { existsSync } from 'fs'
import { cpus } from 'os'
import { join } from 'path'
import type { EmbeddingProvider, EmbeddingInput, Gemma2ProviderConfig } from '../types'
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

export class Gemma2EmbeddingProvider implements EmbeddingProvider {
  private config: Gemma2ProviderConfig
  private model: any = null
  private processor: any = null
  private tokenizer: any = null
  private ready = false

  constructor(config: Gemma2ProviderConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    if (this.ready) return

    const { AutoTokenizer, AutoProcessor, AutoModel, env } =
      await loadTransformers()

    // 强制本地模型
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = this.config.modelsDir

    const modelDirName = this.config.modelDirName || 'gemma2'
    const modelDir = join(this.config.modelsDir, modelDirName)
    if (!existsSync(modelDir)) {
      throw new Error(
        `EmbeddingGemma 2 model not found at ${modelDir}. ` +
        `Run \`node scripts/download-models.mjs gemma2\` or see README for setup.`
      )
    }

    // 量化档位：文本/视觉 q4，音频 q8（官方建议）
    const textDtype = this.config.textQuantization || 'q4'
    const visionDtype = this.config.visionQuantization || 'q4'
    const audioDtype = this.config.audioQuantization || 'q8'

    this.tokenizer = await AutoTokenizer.from_pretrained(modelDirName)
    this.processor = await AutoProcessor.from_pretrained(modelDirName)

    // dtype 按 session 名指定（见 transformers session_config MultimodalEncoder）；
    // 键写错会被静默回退到设备默认 dtype，去找一个没下载的文件。
    this.model = await AutoModel.from_pretrained(modelDirName, {
      dtype: {
        model: textDtype,
        vision_encoder: visionDtype,
        audio_encoder: audioDtype,
      },
      device: this.config.device || 'cpu',
      session_options: {
        // 关掉 BFCArena：视频片段的 vision 激活很大，arena 扩容会一次申请超大对齐块，
        // Electron 的 PartitionAlloc 分配失败直接 SIGTRAP（纯 Node 下不崩）
        enableCpuMemArena: false,
        // 默认每核一个线程，大库后台索引会吃满整机 CPU；只用一半核，给 UI 和其他应用留余量
        intraOpNumThreads: Math.max(1, Math.floor(cpus().length / 2)),
        interOpNumThreads: 1,
      },
    })

    this.ready = true
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    if (!this.ready) throw new Error('Gemma2EmbeddingProvider not initialized')

    switch (input.type) {
      case 'text':
        return this.encodeText(input.content)
      case 'image':
        return this.encodeImage(input.content)
      case 'audio':
        return this.encodeAudio(input.samples)
      case 'video':
        return this.encodeVideo(input.frames, input.durationSec)
      case 'multimodal':
        return this.encodeMultimodal(input)
      default:
        throw new Error(`Unsupported input type: ${(input as any).type}`)
    }
  }

  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    // 暂以串行实现保持简单；后续可针对纯文本/纯图像批量
    const out: Float32Array[] = []
    for (const inp of inputs) out.push(await this.encode(inp))
    return out
  }

  getDimension(): number {
    return EMBEDDING_DIMENSIONS.GEMMA2_BASE
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

  // ---------- 内部编码方法 ----------

  private async encodeText(text: string): Promise<Float32Array> {
    // EmbeddingGemma 2 要求文本 query 加任务前缀
    // 默认当作 search query；如果是 document indexing，调用方传 "task: search result | text: ..."
    const prefixed = text.startsWith('task:') ? text : `task: query | text: ${text}`

    const inputs = this.tokenizer(prefixed, {
      padding: true,
      truncation: true,
    })

    const output = await this.model(inputs)
    // EmbeddingGemma 2 API：.sentence_embedding 已归一化
    return new Float32Array(output.sentence_embedding.data)
  }

  private async encodeImage(imageBuffer: Buffer): Promise<Float32Array> {
    const { RawImage } = await loadTransformers()
    const ab = new ArrayBuffer(imageBuffer.byteLength)
    new Uint8Array(ab).set(imageBuffer)
    const blob = new Blob([ab])
    const image = await RawImage.read(blob)

    const inputs = await this.processor(null, image, null, null)
    const output = await this.model(inputs)
    return new Float32Array(output.sentence_embedding.data)
  }

  private async encodeAudio(samples: Float32Array): Promise<Float32Array> {
    // processor 第三个参数是 audio
    // EmbeddingGemma 2 audio encoder 要求 mono 16kHz Float32Array
    const inputs = await this.processor(null, null, samples, null)
    const output = await this.model(inputs)
    return new Float32Array(output.sentence_embedding.data)
  }

  private async encodeVideo(frames: Buffer[], durationSec: number): Promise<Float32Array> {
    const { RawImage, RawVideo } = await loadTransformers()

    // Buffer[] → RawImage[]
    const rawImages: any[] = []
    for (const frameBuffer of frames) {
      const ab = new ArrayBuffer(frameBuffer.byteLength)
      new Uint8Array(ab).set(frameBuffer)
      const blob = new Blob([ab])
      const img = await RawImage.read(blob)
      rawImages.push(img)
    }

    const video = new RawVideo(rawImages, durationSec)

    // processor 第四个参数是 videos
    const inputs = await this.processor(null, null, null, video)
    const output = await this.model(inputs)
    return new Float32Array(output.sentence_embedding.data)
  }

  private async encodeMultimodal(input: {
    text?: string
    image?: Buffer
    audio?: Float32Array
    video?: { frames: Buffer[]; durationSec: number }
  }): Promise<Float32Array> {
    const { RawImage, RawVideo } = await loadTransformers()

    let text = input.text || null
    let image = null
    let audio = input.audio || null
    let video = null

    if (input.image) {
      const ab = new ArrayBuffer(input.image.byteLength)
      new Uint8Array(ab).set(input.image)
      const blob = new Blob([ab])
      image = await RawImage.read(blob)
    }

    if (input.video) {
      const rawImages: any[] = []
      for (const frameBuffer of input.video.frames) {
        const ab = new ArrayBuffer(frameBuffer.byteLength)
        new Uint8Array(ab).set(frameBuffer)
        const blob = new Blob([ab])
        const img = await RawImage.read(blob)
        rawImages.push(img)
      }
      video = new RawVideo(rawImages, input.video.durationSec)
    }

    const inputs = await this.processor(text, image, audio, video)
    const output = await this.model(inputs)
    return new Float32Array(output.sentence_embedding.data)
  }
}
