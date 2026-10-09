/**
 * 人脸质量：决定一张脸能不能"开新人物"、能不能自动归类。
 *
 * 三个廉价信号取最小值（任何一项差都不可信）：
 *   - 尺寸：原图上人脸短边像素，背景里 20px 的小脸 embedding 基本是噪声
 *   - 姿态：鼻尖相对两眼中点的水平偏移 / 眼距，近似 yaw；侧脸 embedding 偏离正脸很多
 *   - 清晰度：对齐后 112² 灰度图的拉普拉斯方差，糊脸会和所有人都"有点像"
 * 不跑额外模型（CR-FIQA 之类），全部来自检测已有的 bbox / 关键点 / 对齐图。
 */

import { ALIGNED_SIZE } from './alignment'

export interface FaceQuality {
  /** 0–1，min(size, pose, sharpness) */
  score: number
  /** 原图像素下的人脸短边 */
  sizePx: number
  /** |鼻尖偏移| / 眼距，正脸≈0，侧脸 > 0.5 */
  yaw: number
  /** 拉普拉斯方差 */
  sharpness: number
}

const SIZE_MIN = 24, SIZE_GOOD = 72
const YAW_BAD = 0.6
const SHARP_MIN = 20, SHARP_GOOD = 120

const ramp = (v: number, lo: number, hi: number): number => Math.min(1, Math.max(0, (v - lo) / (hi - lo)))

/**
 * @param bbox / landmarks 归一化坐标（detection 输出）
 * @param imgW / imgH 检测所用图像的像素尺寸
 * @param aligned 对齐后的 112×112×3 RGB
 */
export function faceQuality(
  bbox: { w: number; h: number },
  landmarks: [number, number][],
  imgW: number,
  imgH: number,
  aligned: Buffer
): FaceQuality {
  const sizePx = Math.min(bbox.w * imgW, bbox.h * imgH)

  let yaw = 0
  if (landmarks.length >= 3) {
    const [le, re, nose] = landmarks
    const ex = (re[0] - le[0]) * imgW, ey = (re[1] - le[1]) * imgH
    const eyeDist = Math.hypot(ex, ey)
    if (eyeDist > 0) {
      // 鼻尖到两眼中点的向量投影到眼线方向上
      const mx = (le[0] + re[0]) / 2 * imgW, my = (le[1] + re[1]) / 2 * imgH
      const nx = nose[0] * imgW - mx, ny = nose[1] * imgH - my
      yaw = Math.abs((nx * ex + ny * ey) / eyeDist) / eyeDist
    }
  }

  const sharpness = laplacianVariance(aligned)
  const score = Math.min(ramp(sizePx, SIZE_MIN, SIZE_GOOD), 1 - ramp(yaw, 0, YAW_BAD), ramp(sharpness, SHARP_MIN, SHARP_GOOD))
  return { score, sizePx, yaw, sharpness }
}

/** 只看中央区域（避开对齐后图像边缘的黑边 / 背景），4 邻域拉普拉斯 */
export function laplacianVariance(rgb: Buffer, size = ALIGNED_SIZE): number {
  const gray = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) gray[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]
  const lo = Math.round(size * 0.2), hi = Math.round(size * 0.8)
  let sum = 0, sum2 = 0, n = 0
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const i = y * size + x
      const l = gray[i - 1] + gray[i + 1] + gray[i - size] + gray[i + size] - 4 * gray[i]
      sum += l; sum2 += l * l; n++
    }
  }
  const mean = sum / n
  return sum2 / n - mean * mean
}
