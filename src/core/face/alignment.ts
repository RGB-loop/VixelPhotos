/**
 * 人脸对齐：基于 5 关键点的相似变换
 * 将检测到的人脸裁剪并对齐到 112×112 标准位置
 */

import sharp from 'sharp'

// ArcFace/MobileFaceNet 标准参考点 (112×112)
const REFERENCE_POINTS: [number, number][] = [
  [38.29, 51.69],  // 左眼
  [73.53, 51.69],  // 右眼
  [56.02, 71.74],  // 鼻尖
  [41.54, 92.37],  // 左嘴角
  [70.73, 92.37],  // 右嘴角
]

const OUTPUT_SIZE = 112

/**
 * 计算两组点之间的最优相似变换 (旋转 + 缩放 + 平移)
 * 返回 2×3 仿射矩阵
 */
function estimateSimilarityTransform(
  src: [number, number][],
  dst: [number, number][]
): number[][] {
  const n = src.length

  // 计算质心
  let srcCx = 0, srcCy = 0, dstCx = 0, dstCy = 0
  for (let i = 0; i < n; i++) {
    srcCx += src[i][0]; srcCy += src[i][1]
    dstCx += dst[i][0]; dstCy += dst[i][1]
  }
  srcCx /= n; srcCy /= n; dstCx /= n; dstCy /= n

  // 去中心化
  let num1 = 0, num2 = 0, den = 0
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - srcCx
    const sy = src[i][1] - srcCy
    const dx = dst[i][0] - dstCx
    const dy = dst[i][1] - dstCy

    num1 += dx * sx + dy * sy
    num2 += dx * sy - dy * sx
    den += sx * sx + sy * sy
  }

  const a = num1 / den
  const b = num2 / den

  return [
    [a, b, dstCx - a * srcCx - b * srcCy],
    [-b, a, dstCy + b * srcCx - a * srcCy],
  ]
}

/**
 * 对齐人脸：根据检测到的 5 个关键点，将人脸裁剪对齐为 112×112
 */
export async function alignFace(
  imageBuffer: Buffer,
  landmarks: [number, number][],
  imageWidth: number,
  imageHeight: number
): Promise<Buffer> {
  // landmarks 是归一化坐标 (0-1)，转为像素坐标
  const srcPoints: [number, number][] = landmarks.map(([x, y]) => [
    x * imageWidth,
    y * imageHeight,
  ])

  // 计算从源关键点到标准参考点的变换矩阵
  const M = estimateSimilarityTransform(srcPoints, REFERENCE_POINTS)

  // 计算逆变换（从输出坐标映射到输入坐标）
  const det = M[0][0] * M[1][1] - M[0][1] * M[1][0]
  const invM = [
    [M[1][1] / det, -M[0][1] / det, 0],
    [-M[1][0] / det, M[0][0] / det, 0],
  ]
  invM[0][2] = -(invM[0][0] * M[0][2] + invM[0][1] * M[1][2])
  invM[1][2] = -(invM[1][0] * M[0][2] + invM[1][1] * M[1][2])

  // 用 sharp 的 affine 变换实现（sharp 用逆矩阵）
  // sharp.affine 接受 [[a, b], [c, d]] 格式的 2x2 矩阵 + offset
  const aligned = await sharp(imageBuffer)
    .affine(
      [[invM[0][0], invM[0][1]], [invM[1][0], invM[1][1]]],
      {
        odx: invM[0][2],
        ody: invM[1][2],
        idx: 0,
        idy: 0,
      }
    )
    .resize(OUTPUT_SIZE, OUTPUT_SIZE)
    .removeAlpha()
    .raw()
    .toBuffer()

  return aligned
}

/**
 * 简单的人脸裁剪（不做对齐，用于缩略图显示）
 */
export async function cropFace(
  imageBuffer: Buffer,
  bbox: { x: number; y: number; w: number; h: number },
  outputSize: number = 80
): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata()
  const imgW = metadata.width || 1
  const imgH = metadata.height || 1

  // bbox 是归一化坐标，加 padding
  const pad = 0.2
  const x = Math.max(0, Math.floor((bbox.x - pad * bbox.w) * imgW))
  const y = Math.max(0, Math.floor((bbox.y - pad * bbox.h) * imgH))
  const w = Math.min(imgW - x, Math.ceil(bbox.w * (1 + 2 * pad) * imgW))
  const h = Math.min(imgH - y, Math.ceil(bbox.h * (1 + 2 * pad) * imgH))

  if (w <= 0 || h <= 0) return Buffer.alloc(0)

  return sharp(imageBuffer)
    .extract({ left: x, top: y, width: w, height: h })
    .resize(outputSize, outputSize, { fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer()
}
