/**
 * PaddleOCR v5 orchestrator
 *
 * 单一入口 processPhotoOcr(buffer) → 拼好的文本字符串。
 *
 * 模型布局（约定）：
 *   <modelsDir>/paddleocr/
 *     ├── ppocr_v5_det.onnx
 *     ├── ppocr_v5_rec.onnx
 *     ├── ppocr_v5_cls.onnx       (可选；缺则跳过 180° 检测)
 *     └── ppocr_keys_v1.txt
 *
 * 全部 ONNX，由 onnxruntime-node 加载；与人脸模型共享同一推理栈。
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { initDetection, isDetectionReady, detectTextBoxes } from './detection'
import { initRecognition, isRecognitionReady, recognizeBoxes } from './recognition'
import { initCls, isClsReady, detectFlips } from './cls'
import type { OcrResult } from './types'

export type { OcrResult } from './types'

let initialized = false
let initializing = false
let _modelsDir = ''

/** 由 main 在启动时调用 */
export function setOcrModelsDir(dir: string): void {
  _modelsDir = dir
}

/**
 * 懒加载：第一次调用 processPhotoOcr 时会自动 init。
 * 也可显式 init 来提前预热。
 */
export async function initOcrService(): Promise<boolean> {
  if (initialized) return true
  if (initializing) return false
  initializing = true
  try {
    const base = join(_modelsDir, 'paddleocr')
    const det = join(base, 'ppocr_v5_det.onnx')
    const rec = join(base, 'ppocr_v5_rec.onnx')
    const cls = join(base, 'ppocr_v5_cls.onnx')
    const keys = join(base, 'ppocr_keys_v1.txt')

    if (!existsSync(det)) {
      console.warn(`OCR det model missing: ${det}`)
      return false
    }
    if (!existsSync(rec)) {
      console.warn(`OCR rec model missing: ${rec}`)
      return false
    }
    if (!existsSync(keys)) {
      console.warn(`OCR charset missing: ${keys}`)
      return false
    }

    await initDetection(det)
    await initRecognition(rec, keys)
    if (existsSync(cls)) {
      try {
        await initCls(cls)
      } catch (err) {
        console.warn('OCR cls model failed to load (skipping 180° detection):', err)
      }
    }

    initialized = true
    return true
  } catch (err) {
    console.error('OCR init failed:', err)
    return false
  } finally {
    initializing = false
  }
}

export function isOcrReady(): boolean {
  return initialized && isDetectionReady() && isRecognitionReady()
}

/**
 * 对单张图片做完整 OCR：det → cls (optional) → rec → join。
 *
 * 返回拼好的文本（一行一句，按从上到下、从左到右排序）。
 * 文本写入 FTS5 后即可被 BM25 检索到。
 */
export async function processPhotoOcr(imageBuffer: Buffer): Promise<OcrResult> {
  if (!initialized) {
    const ok = await initOcrService()
    if (!ok) throw new Error('OCR service not available')
  }

  // 1) 检测
  const boxes = await detectTextBoxes(imageBuffer)
  if (boxes.length === 0) {
    return { text: '', lines: [] }
  }

  // 2) 方向修正：cls 决定哪些框需要 180° 翻转，旋转其 polygon 顺序即可
  // (recognition 会按 polygon 的 AABB crop，旋转是在标签层面，对识别的
  // 实际影响有限；这一步主要是保留位错信息以便后续可视化。)
  if (isClsReady()) {
    try {
      const flips = await detectFlips(imageBuffer, boxes)
      for (let i = 0; i < boxes.length; i++) {
        if (flips[i]) {
          // 翻转 polygon 顺序，标识该框文字方向倒置
          boxes[i].polygon = [...boxes[i].polygon].reverse() as [number, number][]
        }
      }
    } catch (err) {
      console.warn('OCR cls inference failed (continuing without it):', err)
    }
  }

  // 3) 识别
  const lines = await recognizeBoxes(imageBuffer, boxes)

  // 4) 拼文本：按 y 中心 → x 左缘排序，丢弃低分（< 0.5）行
  const ordered = lines
    .filter((l) => l.text.trim().length > 0 && l.score >= 0.5)
    .sort((a, b) => {
      const ay = a.polygon.reduce((s, p) => s + p[1], 0) / a.polygon.length
      const by = b.polygon.reduce((s, p) => s + p[1], 0) / b.polygon.length
      if (Math.abs(ay - by) > 10) return ay - by
      const ax = Math.min(...a.polygon.map((p) => p[0]))
      const bx = Math.min(...b.polygon.map((p) => p[0]))
      return ax - bx
    })

  const text = ordered.map((l) => l.text).join('\n')
  return { text, lines: ordered }
}
