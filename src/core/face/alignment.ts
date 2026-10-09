/**
 * 人脸对齐：基于 5 关键点的相似变换
 * 将检测到的人脸裁剪并对齐到 112×112 标准位置
 */

import sharp from 'sharp'

/** 已解码的 RGB 图（3 通道，行优先），检测 / 对齐共用，避免每张脸重复解码 */
export interface RawImage {
  data: Buffer
  width: number
  height: number
}

// ArcFace 标准参考点 (112×112)，与 insightface face_align.arcface_dst 一致
const REFERENCE_POINTS: [number, number][] = [
  [38.2946, 51.6963],  // 左眼
  [73.5318, 51.5014],  // 右眼
  [56.0252, 71.7366],  // 鼻尖
  [41.5493, 92.3655],  // 左嘴角
  [70.7299, 92.2041],  // 右嘴角
]

export const ALIGNED_SIZE = 112

/**
 * 最小二乘相似变换（旋转 + 等比缩放 + 平移），返回把 from 平面坐标映射到 to 平面的函数。
 * 对齐时直接拟合 输出→输入 的方向，逐像素反向采样，不需要再求逆。
 */
export function fitSimilarity(
  from: [number, number][],
  to: [number, number][]
): (x: number, y: number) => [number, number] {
  const n = from.length
  let fx = 0, fy = 0, tx = 0, ty = 0
  for (let i = 0; i < n; i++) {
    fx += from[i][0]; fy += from[i][1]
    tx += to[i][0]; ty += to[i][1]
  }
  fx /= n; fy /= n; tx /= n; ty /= n

  let num1 = 0, num2 = 0, den = 0
  for (let i = 0; i < n; i++) {
    const x = from[i][0] - fx, y = from[i][1] - fy
    const u = to[i][0] - tx, v = to[i][1] - ty
    num1 += x * u + y * v
    num2 += x * v - y * u
    den += x * x + y * y
  }
  const a = num1 / den
  const b = num2 / den
  return (x, y) => [a * (x - fx) - b * (y - fy) + tx, b * (x - fx) + a * (y - fy) + ty]
}

/**
 * 对齐人脸：根据 5 个关键点（归一化坐标）把人脸摆正、裁成 112×112 RGB raw。
 *
 * 不用 sharp.affine：它要的是正向矩阵，且 sharp 管线固定先 resize 再 affine，
 * 之前的写法输出的是尺寸不定的黑图（所有人 embedding 相似度都是 1.0）。
 * 112×112 只有 1.2 万像素，JS 双线性采样 < 1ms。
 */
export function alignFace(img: RawImage, landmarks: [number, number][], mirror = false): Buffer {
  const { data, width: W, height: H } = img
  const src = landmarks.map(([x, y]) => [x * W, y * H] as [number, number])
  const map = fitSimilarity(REFERENCE_POINTS, src)
  const out = Buffer.alloc(ALIGNED_SIZE * ALIGNED_SIZE * 3)

  for (let oy = 0; oy < ALIGNED_SIZE; oy++) {
    for (let ox = 0; ox < ALIGNED_SIZE; ox++) {
      const [x, y] = map(mirror ? ALIGNED_SIZE - 1 - ox : ox, oy)
      const x0 = Math.floor(x), y0 = Math.floor(y)
      const ax = x - x0, ay = y - y0
      const o = (oy * ALIGNED_SIZE + ox) * 3
      for (let c = 0; c < 3; c++) {
        const p = (xx: number, yy: number): number =>
          xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : data[(yy * W + xx) * 3 + c]
        out[o + c] = Math.round(
          p(x0, y0) * (1 - ax) * (1 - ay) + p(x0 + 1, y0) * ax * (1 - ay) +
          p(x0, y0 + 1) * (1 - ax) * ay + p(x0 + 1, y0 + 1) * ax * ay
        )
      }
    }
  }
  return out
}

/**
 * 简单的人脸裁剪（不做对齐，用于缩略图显示）
 */
export async function cropFace(
  imageBuffer: Buffer,
  bbox: { x: number; y: number; w: number; h: number },
  outputSize: number = 80
): Promise<Buffer> {
  // bbox 是在按 EXIF 摆正后的图上算的，这里也先摆正
  const oriented = await sharp(imageBuffer).rotate().raw().toBuffer({ resolveWithObject: true })
  const imgW = oriented.info.width || 1
  const imgH = oriented.info.height || 1

  // bbox 是归一化坐标，加 padding
  const pad = 0.2
  const x = Math.max(0, Math.floor((bbox.x - pad * bbox.w) * imgW))
  const y = Math.max(0, Math.floor((bbox.y - pad * bbox.h) * imgH))
  const w = Math.min(imgW - x, Math.ceil(bbox.w * (1 + 2 * pad) * imgW))
  const h = Math.min(imgH - y, Math.ceil(bbox.h * (1 + 2 * pad) * imgH))

  if (w <= 0 || h <= 0) return Buffer.alloc(0)

  const { width, height, channels } = oriented.info
  return sharp(oriented.data, { raw: { width, height, channels } })
    .extract({ left: x, top: y, width: w, height: h })
    .resize(outputSize, outputSize, { fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer()
}
