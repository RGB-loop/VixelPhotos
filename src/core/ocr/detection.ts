/**
 * PaddleOCR v5 text detection — DB (Differentiable Binarization)
 *
 * Pipeline:
 *   resize → normalize (ImageNet mean/std) → ONNX → sigmoid → binarize
 *   → contour → expand polygon (Vatti-clip approx) → NMS
 *
 * Reference: paddleocr/ppocr/postprocess/db_postprocess.py
 *
 * Public surface: initDetection(modelPath), detectTextBoxes(imageBuffer).
 */

import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { CPU_SESSION_OPTIONS } from '../inference/session-options'
import type { TextBox } from './types'

// 模型超参（与 PaddleOCR v5 mobile/server 默认对齐）
const MAX_SIDE_LEN = 960          // 长边上限，长边超过则等比缩放
const DET_SIDE_DIVISOR = 32       // 长宽都需要是 32 的整数倍
const BINARIZE_THRESH = 0.3       // 二值化阈值
const BOX_SCORE_THRESH = 0.6      // 框置信度阈值
const UNCLIP_RATIO = 1.5          // polygon 外扩比例（Vatti-clip 近似）
const MIN_BOX_SIZE = 3            // 像素，过小的框丢弃

// ImageNet 归一化
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

let session: ort.InferenceSession | null = null

export async function initDetection(modelPath: string): Promise<void> {
  session = await ort.InferenceSession.create(modelPath, CPU_SESSION_OPTIONS)
}

export function isDetectionReady(): boolean {
  return session !== null
}

export async function detectTextBoxes(imageBuffer: Buffer): Promise<TextBox[]> {
  if (!session) throw new Error('OCR detection not initialized')

  const meta = await sharp(imageBuffer).metadata()
  const origW = meta.width || 1
  const origH = meta.height || 1

  // 长边缩放到 MAX_SIDE_LEN，并对齐到 32 的倍数
  const ratio = Math.min(1, MAX_SIDE_LEN / Math.max(origW, origH))
  let resizeW = Math.max(DET_SIDE_DIVISOR, Math.round(origW * ratio / DET_SIDE_DIVISOR) * DET_SIDE_DIVISOR)
  let resizeH = Math.max(DET_SIDE_DIVISOR, Math.round(origH * ratio / DET_SIDE_DIVISOR) * DET_SIDE_DIVISOR)
  if (resizeW <= 0) resizeW = DET_SIDE_DIVISOR
  if (resizeH <= 0) resizeH = DET_SIDE_DIVISOR

  // resize → raw RGB
  const { data, info } = await sharp(imageBuffer)
    .resize(resizeW, resizeH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const w = info.width
  const h = info.height

  // CHW float32 normalized
  const chw = new Float32Array(3 * w * h)
  const plane = w * h
  for (let i = 0; i < plane; i++) {
    const r = data[i * 3 + 0] / 255
    const g = data[i * 3 + 1] / 255
    const b = data[i * 3 + 2] / 255
    chw[0 * plane + i] = (r - MEAN[0]) / STD[0]
    chw[1 * plane + i] = (g - MEAN[1]) / STD[1]
    chw[2 * plane + i] = (b - MEAN[2]) / STD[2]
  }

  const input = new ort.Tensor('float32', chw, [1, 3, h, w])
  const outputs = await session.run({ x: input })
  const probMap = firstOutput(outputs) // shape [1,1,H,W] or [1,H,W]
  if (!probMap) return []

  const probData = probMap.data as Float32Array
  const boxesScaledToInput = extractBoxes(probData, w, h)

  // 把框从模型输入坐标系还原到原图坐标系
  const scaleX = origW / w
  const scaleY = origH / h
  return boxesScaledToInput.map((b) => ({
    polygon: b.polygon.map(([x, y]) => [x * scaleX, y * scaleY]) as [number, number][],
    score: b.score,
  }))
}

// ------------------------- 内部 -------------------------

function firstOutput(outputs: Record<string, ort.Tensor>): ort.Tensor | undefined {
  for (const k of Object.keys(outputs)) return outputs[k]
  return undefined
}

interface BBoxLite {
  polygon: [number, number][]
  score: number
}

/**
 * 从二值概率图里抽连通区域 → 最小外接矩形 → 外扩 → 输出框。
 *
 * 这是 DBPostProcess.boxes_from_bitmap 的 TS 版，简化为：
 *   1. 二值化 prob > BINARIZE_THRESH
 *   2. 用 floodfill 找连通块
 *   3. 对每块求最小外接旋转矩形（用 4 角点近似）
 *   4. score = block 内 prob 均值
 *   5. unclip：按 perimeter / area * UNCLIP_RATIO 外扩
 *   6. 丢弃过小或低分的
 */
function extractBoxes(prob: Float32Array, w: number, h: number): BBoxLite[] {
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > BINARIZE_THRESH ? 1 : 0

  const visited = new Uint8Array(w * h)
  const boxes: BBoxLite[] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!bin[idx] || visited[idx]) continue

      // BFS 收集连通块
      const pixels: number[] = []
      const queue: number[] = [idx]
      visited[idx] = 1
      let minX = x, maxX = x, minY = y, maxY = y
      let probSum = 0
      while (queue.length > 0) {
        const cur = queue.pop()!
        pixels.push(cur)
        probSum += prob[cur]
        const cy = Math.floor(cur / w)
        const cx = cur - cy * w
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        // 4-邻
        const neighbors = [cur - 1, cur + 1, cur - w, cur + w]
        for (const n of neighbors) {
          if (n < 0 || n >= bin.length) continue
          if (!bin[n] || visited[n]) continue
          // 边界检查（避免横跨 row）
          const ny = Math.floor(n / w)
          const nx = n - ny * w
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue
          visited[n] = 1
          queue.push(n)
        }
      }

      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      if (bw < MIN_BOX_SIZE || bh < MIN_BOX_SIZE) continue
      const score = probSum / pixels.length
      if (score < BOX_SCORE_THRESH) continue

      // 用 AABB 近似最小外接矩形（旋转矩形的精确版需要 OpenCV）。
      // 对照片场景文本检测足够；倾斜票据场景下会丢一些精度，可在 PR4+ 升级。
      const polygon: [number, number][] = [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ]

      // Unclip：按 area / perimeter * ratio 外扩
      const area = bw * bh
      const perimeter = 2 * (bw + bh)
      const distance = (area * UNCLIP_RATIO) / perimeter
      const expanded: [number, number][] = [
        [Math.max(0, polygon[0][0] - distance), Math.max(0, polygon[0][1] - distance)],
        [Math.min(w - 1, polygon[1][0] + distance), Math.max(0, polygon[1][1] - distance)],
        [Math.min(w - 1, polygon[2][0] + distance), Math.min(h - 1, polygon[2][1] + distance)],
        [Math.max(0, polygon[3][0] - distance), Math.min(h - 1, polygon[3][1] + distance)],
      ]

      boxes.push({ polygon: expanded, score })
    }
  }

  // 按 score 从高到低；OCR 阶段不再做 NMS（DB 输出本来就比较干净）
  boxes.sort((a, b) => b.score - a.score)
  return boxes
}
