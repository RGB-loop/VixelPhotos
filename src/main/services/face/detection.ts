/**
 * SCRFD 人脸检测：使用 ONNX Runtime 推理
 * 输入图片 → 输出人脸 bbox + 5 关键点 + 置信度
 */

import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number }  // 归一化坐标 0-1
  confidence: number
  landmarks: [number, number][]  // 5 个关键点，归一化坐标
}

const INPUT_SIZE = 640
const CONFIDENCE_THRESHOLD = 0.5
const NMS_THRESHOLD = 0.4
const FEAT_STRIDES = [8, 16, 32]
const NUM_ANCHORS = 2

let session: ort.InferenceSession | null = null

export async function initDetection(modelPath: string): Promise<void> {
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  })
  console.log('SCRFD face detection model loaded')
}

export function isDetectionReady(): boolean {
  return session !== null
}

/**
 * 预处理图片为 SCRFD 输入格式
 */
async function preprocessImage(imageBuffer: Buffer): Promise<{
  tensor: ort.Tensor
  scale: number
  padW: number
  padH: number
  origW: number
  origH: number
}> {
  const metadata = await sharp(imageBuffer).metadata()
  const origW = metadata.width || 1
  const origH = metadata.height || 1

  // 等比缩放到 INPUT_SIZE，保持宽高比
  const scale = Math.min(INPUT_SIZE / origW, INPUT_SIZE / origH)
  const newW = Math.round(origW * scale)
  const newH = Math.round(origH * scale)
  const padW = INPUT_SIZE - newW
  const padH = INPUT_SIZE - newH

  // 缩放 + 填充
  const raw = await sharp(imageBuffer)
    .resize(newW, newH)
    .extend({
      top: 0,
      bottom: padH,
      left: 0,
      right: padW,
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer()

  // HWC → CHW, float32, 归一化
  const float32 = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE)
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    float32[i] = raw[i * 3] / 128.0 - 1.0                      // R
    float32[INPUT_SIZE * INPUT_SIZE + i] = raw[i * 3 + 1] / 128.0 - 1.0  // G
    float32[2 * INPUT_SIZE * INPUT_SIZE + i] = raw[i * 3 + 2] / 128.0 - 1.0  // B
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, INPUT_SIZE, INPUT_SIZE])
  return { tensor, scale, padW, padH, origW, origH }
}

/**
 * 生成 anchor 中心点
 */
function generateAnchorCenters(featH: number, featW: number, stride: number): [number, number][] {
  const centers: [number, number][] = []
  for (let y = 0; y < featH; y++) {
    for (let x = 0; x < featW; x++) {
      for (let a = 0; a < NUM_ANCHORS; a++) {
        centers.push([x * stride, y * stride])
      }
    }
  }
  return centers
}

/**
 * 非极大值抑制
 */
function nms(faces: DetectedFace[], threshold: number): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.confidence - a.confidence)
  const keep: DetectedFace[] = []

  const suppressed = new Set<number>()
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue
    keep.push(sorted[i])

    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue
      const iou = computeIoU(sorted[i].bbox, sorted[j].bbox)
      if (iou > threshold) suppressed.add(j)
    }
  }

  return keep
}

function computeIoU(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = a.w * a.h
  const areaB = b.w * b.h

  return intersection / (areaA + areaB - intersection + 1e-6)
}

/**
 * 检测图片中的所有人脸
 */
export async function detectFaces(imageBuffer: Buffer): Promise<DetectedFace[]> {
  if (!session) throw new Error('Detection model not initialized')

  const { tensor, scale, origW, origH } = await preprocessImage(imageBuffer)

  const feeds: Record<string, ort.Tensor> = {}
  const inputName = session.inputNames[0]
  feeds[inputName] = tensor

  const results = await session.run(feeds)
  const outputNames = session.outputNames

  // SCRFD 输出顺序: score_8, score_16, score_32, bbox_8, bbox_16, bbox_32, kps_8, kps_16, kps_32
  const allFaces: DetectedFace[] = []

  for (let idx = 0; idx < FEAT_STRIDES.length; idx++) {
    const stride = FEAT_STRIDES[idx]
    const featH = Math.floor(INPUT_SIZE / stride)
    const featW = Math.floor(INPUT_SIZE / stride)
    const anchors = generateAnchorCenters(featH, featW, stride)

    const scoreData = results[outputNames[idx]].data as Float32Array
    const bboxData = results[outputNames[idx + FEAT_STRIDES.length]].data as Float32Array
    const kpsData = results[outputNames[idx + FEAT_STRIDES.length * 2]]?.data as Float32Array | undefined

    for (let i = 0; i < anchors.length; i++) {
      const score = scoreData[i]
      if (score < CONFIDENCE_THRESHOLD) continue

      const [cx, cy] = anchors[i]
      const bx = bboxData[i * 4]
      const by = bboxData[i * 4 + 1]
      const bw = bboxData[i * 4 + 2]
      const bh = bboxData[i * 4 + 3]

      // 解码 bbox (距离格式 → 左上右下)
      const x1 = (cx - bx * stride) / scale
      const y1 = (cy - by * stride) / scale
      const x2 = (cx + bw * stride) / scale
      const y2 = (cy + bh * stride) / scale

      // 归一化到 0-1
      const bbox = {
        x: Math.max(0, x1 / origW),
        y: Math.max(0, y1 / origH),
        w: Math.min(1 - x1 / origW, (x2 - x1) / origW),
        h: Math.min(1 - y1 / origH, (y2 - y1) / origH),
      }

      // 解码关键点
      const landmarks: [number, number][] = []
      if (kpsData) {
        for (let k = 0; k < 5; k++) {
          const kx = (cx + kpsData[i * 10 + k * 2] * stride) / scale / origW
          const ky = (cy + kpsData[i * 10 + k * 2 + 1] * stride) / scale / origH
          landmarks.push([
            Math.max(0, Math.min(1, kx)),
            Math.max(0, Math.min(1, ky)),
          ])
        }
      }

      allFaces.push({ bbox, confidence: score, landmarks })
    }
  }

  return nms(allFaces, NMS_THRESHOLD)
}
