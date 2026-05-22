/**
 * PaddleOCR v5 text recognition — CRNN + CTC head
 *
 * Pipeline (per text box):
 *   crop polygon (with perspective warp) → resize to (rec_h, dynamic w)
 *   → normalize → ONNX → CTC greedy decode → charset lookup
 *
 * Reference: paddleocr/ppocr/postprocess/rec_postprocess.py
 */

import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { readFileSync } from 'fs'
import type { RecognizedLine, TextBox } from './types'

// PaddleOCR v5 默认配置
const REC_IMG_H = 48              // 输入高度（v5 默认 48）
const REC_BATCH_SIZE = 6          // 每批一次性推理多少个文本框
const REC_MAX_WIDTH = 320         // 任一框最大输入宽度（防止极长行 OOM）

// 归一化（PP-OCR v5 与 ImageNet 相同 mean/std；v3 是 [0.5, 0.5, 0.5]）
const MEAN = [0.5, 0.5, 0.5]
const STD = [0.5, 0.5, 0.5]

let session: ort.InferenceSession | null = null
let charset: string[] | null = null

/**
 * 初始化识别器。
 * @param modelPath path to rec.onnx
 * @param charsetPath path to ppocr_keys_v1.txt（每行一个字符，加空白和 \n 即可）
 */
export async function initRecognition(modelPath: string, charsetPath: string): Promise<void> {
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  })

  const raw = readFileSync(charsetPath, 'utf-8')
  // PaddleOCR 字典：CTC blank 在 index 0，dict 从 index 1 开始
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
  charset = ['<blank>', ...lines, ' '] // 末尾空格为 PaddleOCR 习惯
}

export function isRecognitionReady(): boolean {
  return session !== null && charset !== null
}

/**
 * 对一组文本框运行识别。返回每个框对应的识别结果（按输入顺序）。
 */
export async function recognizeBoxes(
  imageBuffer: Buffer,
  boxes: TextBox[]
): Promise<RecognizedLine[]> {
  if (!isRecognitionReady() || !session || !charset) {
    throw new Error('OCR recognition not initialized')
  }
  if (boxes.length === 0) return []

  // 1) 全部 crop + resize 到统一 H，记录各自宽度
  const crops: Array<{ chw: Float32Array; w: number; box: TextBox }> = []
  for (const box of boxes) {
    const crop = await cropAndNormalize(imageBuffer, box)
    if (crop) crops.push({ ...crop, box })
  }
  if (crops.length === 0) return []

  // 2) 分批：每批内 padding 到 max(w)，统一成 [B, 3, H, maxW]
  const results: RecognizedLine[] = []
  for (let i = 0; i < crops.length; i += REC_BATCH_SIZE) {
    const batch = crops.slice(i, i + REC_BATCH_SIZE)
    const maxW = batch.reduce((m, c) => Math.max(m, c.w), 0)
    const batchTensor = new Float32Array(batch.length * 3 * REC_IMG_H * maxW)
    for (let b = 0; b < batch.length; b++) {
      const { chw, w } = batch[b]
      // chw 形状是 [3, REC_IMG_H, w]，需要在 width 维右侧 padding 到 maxW（用 0）
      const offsetB = b * 3 * REC_IMG_H * maxW
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < REC_IMG_H; y++) {
          const srcRow = (c * REC_IMG_H + y) * w
          const dstRow = offsetB + (c * REC_IMG_H + y) * maxW
          for (let x = 0; x < w; x++) {
            batchTensor[dstRow + x] = chw[srcRow + x]
          }
        }
      }
    }

    const input = new ort.Tensor('float32', batchTensor, [batch.length, 3, REC_IMG_H, maxW])
    const outputs = await session.run({ x: input })
    const logits = firstOutput(outputs)
    if (!logits) continue

    const decoded = ctcGreedyDecode(
      logits.data as Float32Array,
      logits.dims as number[],
      charset
    )

    for (let b = 0; b < batch.length; b++) {
      const { text, score } = decoded[b] || { text: '', score: 0 }
      results.push({
        text,
        polygon: batch[b].box.polygon,
        score,
      })
    }
  }

  return results
}

// ------------------------- 内部 -------------------------

function firstOutput(outputs: Record<string, ort.Tensor>): ort.Tensor | undefined {
  for (const k of Object.keys(outputs)) return outputs[k]
  return undefined
}

/**
 * 把 polygon 区域裁出来，resize 到 (REC_IMG_H, dynamic_w)，归一化为 CHW。
 *
 * 这里用 polygon 的 AABB 简化裁剪（不做透视校正）。对水平文本足够；
 * 若需要倾斜文本完美校正，要做透视变换（需要 4 点矩阵乘法 + 双线性采样）。
 * 大多数照片 OCR 用例靠 cls 阶段处理 180° 翻转 + 这里的 AABB 就 OK。
 */
async function cropAndNormalize(
  imageBuffer: Buffer,
  box: TextBox
): Promise<{ chw: Float32Array; w: number } | null> {
  const xs = box.polygon.map((p) => p[0])
  const ys = box.polygon.map((p) => p[1])
  const left = Math.max(0, Math.floor(Math.min(...xs)))
  const top = Math.max(0, Math.floor(Math.min(...ys)))
  const right = Math.ceil(Math.max(...xs))
  const bottom = Math.ceil(Math.max(...ys))
  const cropW = right - left
  const cropH = bottom - top
  if (cropW < 2 || cropH < 2) return null

  // 计算等比缩放后的宽度
  const targetW = Math.min(
    REC_MAX_WIDTH,
    Math.max(8, Math.round((cropW * REC_IMG_H) / cropH))
  )

  const { data } = await sharp(imageBuffer)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(targetW, REC_IMG_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const plane = targetW * REC_IMG_H
  const chw = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    const r = data[i * 3 + 0] / 255
    const g = data[i * 3 + 1] / 255
    const b = data[i * 3 + 2] / 255
    chw[0 * plane + i] = (r - MEAN[0]) / STD[0]
    chw[1 * plane + i] = (g - MEAN[1]) / STD[1]
    chw[2 * plane + i] = (b - MEAN[2]) / STD[2]
  }
  return { chw, w: targetW }
}

/**
 * CTC 贪心解码：argmax + 去重 + 去 blank。
 *
 * logits 形状常见为 [B, T, C]（PP-OCR v3/v4 是 [B, C, T] 的也见过，
 * 这里按 dims 自适应）。
 *
 * @returns 每个 batch 对应的 {text, score}
 */
function ctcGreedyDecode(
  data: Float32Array,
  dims: number[],
  charset: string[]
): Array<{ text: string; score: number }> {
  // 自适应：找出哪一维是 T（time / seq_len），哪一维是 C（charset+1）
  const [B, d1, d2] = dims
  const C = charset.length
  let T: number, isBTC: boolean
  if (d2 === C) {
    T = d1
    isBTC = true
  } else if (d1 === C) {
    T = d2
    isBTC = false
  } else {
    // 找不到匹配维：默认按 [B, T, C] 处理
    T = d1
    isBTC = true
  }

  const out: Array<{ text: string; score: number }> = []

  for (let b = 0; b < B; b++) {
    let prev = -1
    const indices: number[] = []
    const probs: number[] = []

    for (let t = 0; t < T; t++) {
      // softmax 仅取 argmax + max prob（不必算全 softmax）
      let bestIdx = 0
      let bestVal = -Infinity
      let sumExp = 0
      // 第一遍找 bestVal 用于数值稳定
      for (let c = 0; c < C; c++) {
        const v = isBTC ? data[b * T * C + t * C + c] : data[b * C * T + c * T + t]
        if (v > bestVal) {
          bestVal = v
          bestIdx = c
        }
      }
      // 第二遍做 stable softmax 只为了估这一个字符的 prob
      for (let c = 0; c < C; c++) {
        const v = isBTC ? data[b * T * C + t * C + c] : data[b * C * T + c * T + t]
        sumExp += Math.exp(v - bestVal)
      }
      const prob = 1 / sumExp

      // CTC 规则：连续重复 + blank(0) 都丢
      if (bestIdx !== prev && bestIdx !== 0) {
        indices.push(bestIdx)
        probs.push(prob)
      }
      prev = bestIdx
    }

    const text = indices.map((i) => charset[i] || '').join('')
    const score =
      probs.length === 0
        ? 0
        : probs.reduce((s, p) => s + p, 0) / probs.length
    out.push({ text, score })
  }

  return out
}
