/**
 * 把 EmbeddingGemma 2 的推理转发到推理进程（见 ../../inference/transport.ts）。
 * 进程里跑的是 LiteRtEmbeddingProvider；这里只做转发，推理进程重启后下次调用前自动重新 init。
 */

import type { EmbeddingProvider, EmbeddingInput, EmbeddingProviderConfig } from '../types'
import { EMBEDDING_DIMENSIONS } from '../types'
import { RemoteReady, type InferenceTransport } from '../../inference/transport'

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  private ready = new RemoteReady()
  /** 推理进程里实际用上的后端（gpu 不可用时退到 cpu） */
  activeBackend: string | null = null

  constructor(
    private transport: InferenceTransport,
    private config: EmbeddingProviderConfig
  ) {}

  async init(): Promise<void> {
    if (this.ready.isReady(this.transport)) return
    const info = await this.transport.call<{ backend?: string } | undefined>('embed.init', this.config)
    this.activeBackend = info?.backend ?? null
    this.ready.mark(this.transport, true)
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    await this.init()
    return this.transport.call<Float32Array>('embed.encode', input)
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
    return this.ready.isReady(this.transport)
  }

  async dispose(): Promise<void> {
    this.ready.mark(this.transport, false)
    this.activeBackend = null
    await this.transport.call('embed.dispose').catch(() => {})
  }
}
