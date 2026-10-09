import { cpus } from 'os'
import type { InferenceSession } from 'onnxruntime-node'

/**
 * 人脸 / OCR 的小模型共用的 ONNX 会话选项。默认每核一个线程，后台扫描会吃满整机 CPU；
 * 和 EmbeddingGemma 一样只用一半核，给 UI 和其他应用留余量。
 */
export const CPU_SESSION_OPTIONS: InferenceSession.SessionOptions = {
  executionProviders: ['cpu'],
  intraOpNumThreads: Math.max(1, Math.floor(cpus().length / 2)),
  interOpNumThreads: 1,
}
