/**
 * 推理进程（Electron utilityProcess）：EmbeddingGemma 2 / 人脸 / OCR 都在这里跑，
 * 主进程只管数据库和调度，索引期间窗口不卡。协议见 ../core/inference/transport.ts。
 *
 * 请求串行执行（一次前向本来就吃满分配的核，并发只会抢内存）；
 * 搜索框的文本 query 插队到最前，最多等当前这一个推理跑完。
 */

import { Gemma2EmbeddingProvider } from '../core/embedding/providers/gemma2Provider'
import type { EmbeddingInput, Gemma2ProviderConfig } from '../core/embedding/types'
import { initFaceService, processPhotoFaces, setFaceModelsDir } from '../core/face'
import { initOcrService, processPhotoOcr, setOcrModelsDir } from '../core/ocr'
import type { InferenceRequest, InferenceResponse } from '../core/inference/transport'

let embedder: Gemma2EmbeddingProvider | null = null
let embedderKey = ''

// 结构化克隆把 Buffer 变成普通 Uint8Array，sharp 等需要 Buffer 的地方要还原回来
function asBuffer(v: unknown): Buffer {
  const u = v as Uint8Array
  return Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength)
}

function reviveInput(input: EmbeddingInput): EmbeddingInput {
  switch (input.type) {
    case 'image':
      return { ...input, content: asBuffer(input.content) }
    case 'video':
      return { ...input, frames: input.frames.map(asBuffer) }
    case 'multimodal':
      return {
        ...input,
        image: input.image && asBuffer(input.image),
        video: input.video && { ...input.video, frames: input.video.frames.map(asBuffer) },
      }
    default:
      return input
  }
}

const handlers: Record<InferenceRequest['method'], (...args: any[]) => Promise<unknown>> = {
  'embed.init': async (config: Gemma2ProviderConfig) => {
    const key = JSON.stringify(config)
    if (embedder?.isReady() && key === embedderKey) return
    await embedder?.dispose()
    embedder = new Gemma2EmbeddingProvider(config)
    embedderKey = key
    await embedder.init()
  },
  'embed.encode': async (input: EmbeddingInput) => {
    if (!embedder?.isReady()) throw new Error('Embedding model not initialized')
    return embedder.encode(reviveInput(input))
  },
  'embed.dispose': async () => {
    await embedder?.dispose()
    embedder = null
    embedderKey = ''
  },
  'face.init': async (modelsDir: string) => {
    setFaceModelsDir(modelsDir)
    return initFaceService()
  },
  'face.process': async (buf: Uint8Array) => processPhotoFaces(asBuffer(buf)),
  'ocr.init': async (modelsDir: string) => {
    setOcrModelsDir(modelsDir)
    return initOcrService()
  },
  'ocr.process': async (buf: Uint8Array) => processPhotoOcr(asBuffer(buf)),
}

const queue: InferenceRequest[] = []
let busy = false

const isUrgent = (r: InferenceRequest): boolean =>
  r.method === 'embed.encode' && (r.args[0] as EmbeddingInput | undefined)?.type === 'text'

async function drain(): Promise<void> {
  if (busy) return
  busy = true
  while (queue.length > 0) {
    const req = queue.shift()!
    let res: InferenceResponse
    try {
      res = { id: req.id, ok: true, result: await handlers[req.method](...req.args) }
    } catch (err) {
      res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    process.parentPort.postMessage(res)
  }
  busy = false
}

process.parentPort.on('message', (e) => {
  const req = e.data as InferenceRequest
  if (isUrgent(req)) {
    const at = queue.findIndex((r) => !isUrgent(r))
    queue.splice(at < 0 ? queue.length : at, 0, req)
  } else {
    queue.push(req)
  }
  void drain()
})
