/**
 * 人脸 Embedding：InsightFace buffalo_s 的 w600k_mbf（MobileFaceNet 骨干，WebFace600K 训练），
 * 输入 112×112 对齐人脸，输出 512 维 L2 归一化向量。
 * 模型许可：InsightFace 预训练权重仅限非商用。
 */

import { CPU_SESSION_OPTIONS } from '../inference/session-options'
import * as ort from 'onnxruntime-node'

const FACE_SIZE = 112  // 对齐后的人脸尺寸

let session: ort.InferenceSession | null = null

export async function initFaceEmbedding(modelPath: string): Promise<void> {
  session = await ort.InferenceSession.create(modelPath, CPU_SESSION_OPTIONS)
  console.log('MobileFaceNet face embedding model loaded')
}

export function isEmbeddingReady(): boolean {
  return session !== null
}

/**
 * 从对齐的人脸 raw buffer (112×112×3 RGB) 生成 512D embedding
 */
export async function embedFace(alignedRawBuffer: Buffer): Promise<Float32Array> {
  if (!session) throw new Error('Face embedding model not initialized')

  // Raw RGB → CHW float32, 归一化: (pixel - 127.5) / 128.0
  const pixels = FACE_SIZE * FACE_SIZE
  const float32 = new Float32Array(3 * pixels)

  for (let i = 0; i < pixels; i++) {
    float32[i] = (alignedRawBuffer[i * 3] - 127.5) / 128.0              // R
    float32[pixels + i] = (alignedRawBuffer[i * 3 + 1] - 127.5) / 128.0  // G
    float32[2 * pixels + i] = (alignedRawBuffer[i * 3 + 2] - 127.5) / 128.0  // B
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, FACE_SIZE, FACE_SIZE])

  const feeds: Record<string, ort.Tensor> = {}
  feeds[session.inputNames[0]] = tensor

  const results = await session.run(feeds)
  const output = results[session.outputNames[0]].data as Float32Array

  // L2 归一化
  let norm = 0
  for (let i = 0; i < output.length; i++) {
    norm += output[i] * output[i]
  }
  norm = Math.sqrt(norm)

  const normalized = new Float32Array(output.length)
  for (let i = 0; i < output.length; i++) {
    normalized[i] = output[i] / (norm + 1e-10)
  }

  return normalized
}
