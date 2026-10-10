/**
 * EmbeddingGemma 2 经 LiteRT-LM 推理（官方 .litertlm，int4/int8 QAT）。
 *
 * 和原 ONNX（transformers.js + onnxruntime CPU）同一个模型、同为 768 维，但：
 *   - macOS 走 Metal（ML Drift），实测 M5 上每张图 ~0.3 s，ONNX CPU 约 3.3 s；
 *     Windows 走 WebGPU → D3D12；没有可用 GPU 时退回 CPU（XNNPACK，也快约 7 倍）
 *   - 向量与旧 ONNX 版不完全一致（同图余弦中位数 0.95），两者不可混用
 *
 * 一次 compute_embedding 可以带多个输入并融合成一个向量：视频片段 = 若干帧 + 音轨。
 * 运行在推理进程（utilityProcess）里，同步调用 C API（该进程本来就串行处理请求）。
 */
import { cpus, tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import sharp from 'sharp'
import type { EmbeddingInput, EmbeddingProvider, LiteRtProviderConfig } from '../../types'
import { EMBEDDING_DIMENSIONS } from '../../types'
import { InputType, loadLiteRt, type LiteRtNative } from './native'

export const LITERT_MODEL_FILE = 'embeddinggemma-2-740m.litertlm'

/** 官方任务前缀（developers.google.com/edge/litert-lm/embedding_models） */
const QUERY_PREFIX = 'task: search query | text: '

/**
 * 送进去之前把图缩到长边 768：库内部会缩到 ~670×430（≤1260 个 16px patch），
 * 但它先用 stb 解码整张原图 —— 6000×4000 的 JPEG 光解码就要 ~0.6 s。
 */
const IMAGE_MAX_SIDE = 768
const AUDIO_SAMPLE_RATE = 16000
/**
 * 单次推理的最大 token 数。引擎默认只加载 1024 的签名，一个 32 s 视频片段
 * （8 帧 × ~140 + 32 s 音频 ~700）约 1800，会报 "exceeds maximum supported signature length"；
 * 模型自带 128 / 256 / 512 / 1024 / 2048 / 8192 几档，用 2048。
 */
const MAX_INPUT_TOKENS = 2048

async function prepareImage(buf: Buffer): Promise<Buffer> {
  const img = sharp(buf, { failOn: 'none' }).rotate()
  const meta = await img.metadata()
  if ((meta.width ?? 0) <= IMAGE_MAX_SIDE && (meta.height ?? 0) <= IMAGE_MAX_SIDE && meta.format === 'jpeg') return buf
  return img.resize(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
}

/** mono 16 kHz Float32 → 16-bit PCM WAV（库按音频文件字节解码） */
export function toWav(samples: Float32Array, sampleRate = AUDIO_SAMPLE_RATE): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVE', 8)
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return out
}

export class LiteRtEmbeddingProvider implements EmbeddingProvider {
  private native: LiteRtNative | null = null
  private engine: unknown = null
  /** 实际在用的后端（gpu 初始化失败会退到 cpu），给设置页 / 日志看 */
  activeBackend: 'gpu' | 'cpu' | null = null

  constructor(private config: LiteRtProviderConfig) {}

  async init(): Promise<void> {
    if (this.engine) return
    const modelPath = join(this.config.modelsDir, 'litert', LITERT_MODEL_FILE)
    if (!existsSync(modelPath)) throw new Error(`LiteRT model missing: ${modelPath} (run \`npm run models:download\`)`)
    this.native = loadLiteRt(this.config.libDir)
    // 缓存目录必须给：不给时 LiteRT 把几百 MB 的 GPU 权重 / 程序缓存写在模型文件旁边 ——
    // 打包后那是 .app 里面，写进去会破坏签名，/Applications 下也可能没有写权限
    const cacheDir = this.config.cacheDir ?? join(tmpdir(), 'vixel-litert-cache')
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })

    // CPU 后端只用一半核，给 UI 和其他应用留余量
    const opts = { cacheDir, numThreads: Math.max(1, Math.floor(cpus().length / 2)), maxInputTokens: MAX_INPUT_TOKENS }
    const order: Array<'gpu' | 'cpu'> = this.config.backend === 'cpu' ? ['cpu'] : this.config.backend === 'gpu' ? ['gpu'] : ['gpu', 'cpu']
    let lastError: unknown
    for (const backend of order) {
      try {
        this.engine = this.native.createEngine(modelPath, backend, opts)
        this.activeBackend = backend
        console.log(`[litert] EmbeddingGemma 2 ready on ${backend}`)
        return
      } catch (err) {
        lastError = err
        console.warn(`[litert] ${backend} backend unavailable:`, err)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    if (!this.engine || !this.native) throw new Error('LiteRtEmbeddingProvider not initialized')
    const items: Array<[InputType, Buffer]> = []
    const text = (t: string): void => {
      const s = t.trim()
      items.push([InputType.Text, Buffer.from(s.startsWith('task:') ? s : QUERY_PREFIX + s, 'utf8')])
    }
    const image = async (b: Buffer): Promise<void> => { items.push([InputType.Image, await prepareImage(b)]) }
    const audio = (s: Float32Array): void => { if (s.length > 0) items.push([InputType.Audio, toWav(s)]) }

    switch (input.type) {
      case 'text': text(input.content); break
      case 'image': await image(input.content); break
      case 'audio': audio(input.samples); break
      case 'video': for (const f of input.frames) await image(f); break
      case 'multimodal':
        if (input.text) text(input.text)
        if (input.image) await image(input.image)
        for (const f of input.video?.frames ?? []) await image(f)
        if (input.audio) audio(input.audio)
        break
      default:
        throw new Error(`Unsupported input type: ${(input as { type: string }).type}`)
    }
    if (items.length === 0) throw new Error('LiteRtEmbeddingProvider: empty input')
    return this.native.embed(this.engine, items)
  }

  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (const inp of inputs) out.push(await this.encode(inp))
    return out
  }

  getDimension(): number {
    return EMBEDDING_DIMENSIONS.GEMMA2_BASE
  }

  isReady(): boolean {
    return this.engine !== null
  }

  async dispose(): Promise<void> {
    if (this.engine && this.native) this.native.deleteEngine(this.engine)
    this.engine = null
    this.activeBackend = null
  }
}
