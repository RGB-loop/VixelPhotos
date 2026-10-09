/**
 * PaddleOCR v5 angle classifier (180° flip detector)
 *
 * 输入：单个文本框的 crop（resize 到 (48, 192)）
 * 输出：是否需要旋转 180° (label=1 → 旋转 180)
 *
 * 简化策略：对置信度 > 0.9 的 label=1 才翻转，其他保留原样
 */

import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { CPU_SESSION_OPTIONS } from '../inference/session-options'
import type { TextBox } from './types'

const CLS_IMG_H = 48
const CLS_IMG_W = 192
const CLS_THRESHOLD = 0.9

const MEAN = [0.5, 0.5, 0.5]
const STD = [0.5, 0.5, 0.5]

let session: ort.InferenceSession | null = null

export async function initCls(modelPath: string): Promise<void> {
  session = await ort.InferenceSession.create(modelPath, CPU_SESSION_OPTIONS)
}

export function isClsReady(): boolean {
  return session !== null
}

/**
 * 对一组框做方向判断；返回与输入同长度的布尔数组，true = 该框需要 180° 翻转。
 *
 * 如果 cls model 未加载，则返回全 false（即不翻转）—— cls 是可选优化。
 */
export async function detectFlips(
  imageBuffer: Buffer,
  boxes: TextBox[]
): Promise<boolean[]> {
  if (!session || boxes.length === 0) return boxes.map(() => false)

  // 顺序裁剪、归一化、组 batch
  const tensorAll = new Float32Array(boxes.length * 3 * CLS_IMG_H * CLS_IMG_W)
  for (let i = 0; i < boxes.length; i++) {
    const crop = await cropToClsInput(imageBuffer, boxes[i])
    if (!crop) continue
    tensorAll.set(crop, i * 3 * CLS_IMG_H * CLS_IMG_W)
  }

  const input = new ort.Tensor('float32', tensorAll, [boxes.length, 3, CLS_IMG_H, CLS_IMG_W])
  const outputs = await session.run({ x: input })
  const logits = firstOutput(outputs)
  if (!logits) return boxes.map(() => false)

  const data = logits.data as Float32Array
  // cls 模型输出 [B, 2]：[score_0deg, score_180deg]
  const flips: boolean[] = []
  for (let i = 0; i < boxes.length; i++) {
    const a = data[i * 2 + 0]
    const b = data[i * 2 + 1]
    const max = Math.max(a, b)
    const p180 = Math.exp(b - max) / (Math.exp(a - max) + Math.exp(b - max))
    flips.push(p180 > CLS_THRESHOLD)
  }
  return flips
}

function firstOutput(outputs: Record<string, ort.Tensor>): ort.Tensor | undefined {
  for (const k of Object.keys(outputs)) return outputs[k]
  return undefined
}

async function cropToClsInput(imageBuffer: Buffer, box: TextBox): Promise<Float32Array | null> {
  const xs = box.polygon.map((p) => p[0])
  const ys = box.polygon.map((p) => p[1])
  const left = Math.max(0, Math.floor(Math.min(...xs)))
  const top = Math.max(0, Math.floor(Math.min(...ys)))
  const right = Math.ceil(Math.max(...xs))
  const bottom = Math.ceil(Math.max(...ys))
  const cropW = right - left
  const cropH = bottom - top
  if (cropW < 2 || cropH < 2) return null

  const { data } = await sharp(imageBuffer)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(CLS_IMG_W, CLS_IMG_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const plane = CLS_IMG_H * CLS_IMG_W
  const chw = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    const r = data[i * 3 + 0] / 255
    const g = data[i * 3 + 1] / 255
    const b = data[i * 3 + 2] / 255
    chw[0 * plane + i] = (r - MEAN[0]) / STD[0]
    chw[1 * plane + i] = (g - MEAN[1]) / STD[1]
    chw[2 * plane + i] = (b - MEAN[2]) / STD[2]
  }
  return chw
}
