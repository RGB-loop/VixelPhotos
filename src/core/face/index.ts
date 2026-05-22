/**
 * FaceService：人脸检测 + embedding + 增量人物匹配
 *
 * 采用 Immich 风格的增量匹配（非全量聚类）：
 * 新人脸 → 搜索已有人脸的最近邻 → 距离够近则归入已有人物，否则创建新人物
 * 用户命名永远保留，不会被重聚类覆盖
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { initDetection, isDetectionReady, detectFaces } from './detection'
import { initFaceEmbedding, isEmbeddingReady, embedFace } from './embedding'
import { alignFace, cropFace } from './alignment'
import { dot, l2ToCosineDistance } from './distance'
import type { DatabaseInstance } from '../db'
import type { FaceBbox } from '../../shared/types'
import sharp from 'sharp'

// 人物匹配阈值：余弦距离 ≤ 此值认为是同一个人
// 余弦距离 = 1 - cosine_similarity，所以 0.6 对应相似度 0.4
// Immich 默认 maxDistance ≈ 0.6
const MAX_DISTANCE = 0.6

let initialized = false
let initializing = false
let _modelsDir: string = ''

export function setFaceModelsDir(dir: string): void {
  _modelsDir = dir
}

function getModelsDir(): string {
  if (_modelsDir && existsSync(_modelsDir)) return _modelsDir
  const devPath = join(process.cwd(), 'resources', 'models')
  if (existsSync(devPath)) return devPath
  return _modelsDir || devPath
}

export async function initFaceService(): Promise<boolean> {
  if (initialized) return true
  if (initializing) return false

  initializing = true
  try {
    const modelsDir = getModelsDir()
    const detectionModel = join(modelsDir, 'scrfd_2.5g_kps.onnx')
    const embeddingModel = join(modelsDir, 'mobilefacenet.onnx')

    if (!existsSync(detectionModel)) {
      console.warn('Face detection model not found:', detectionModel)
      return false
    }
    if (!existsSync(embeddingModel)) {
      console.warn('Face embedding model not found:', embeddingModel)
      return false
    }

    await initDetection(detectionModel)
    await initFaceEmbedding(embeddingModel)

    initialized = true
    console.log('Face service initialized')
    return true
  } catch (error) {
    console.error('Failed to initialize face service:', error)
    return false
  } finally {
    initializing = false
  }
}

export function isFaceServiceReady(): boolean {
  return initialized && isDetectionReady() && isEmbeddingReady()
}

/**
 * 处理单张照片的人脸检测 + embedding
 */
export async function processPhotoFaces(
  imageBuffer: Buffer
): Promise<Array<{
  faceIndex: number
  bbox: FaceBbox
  confidence: number
  embedding: Float32Array
}>> {
  if (!isFaceServiceReady()) {
    throw new Error('Face service not ready')
  }

  const metadata = await sharp(imageBuffer).metadata()
  const imgW = metadata.width || 1
  const imgH = metadata.height || 1

  const detected = await detectFaces(imageBuffer)
  if (detected.length === 0) return []

  const results: Array<{
    faceIndex: number
    bbox: FaceBbox
    confidence: number
    embedding: Float32Array
  }> = []

  for (let i = 0; i < detected.length; i++) {
    const face = detected[i]
    try {
      const alignedRaw = await alignFace(imageBuffer, face.landmarks, imgW, imgH)
      const embedding = await embedFace(alignedRaw)
      results.push({ faceIndex: i, bbox: face.bbox, confidence: face.confidence, embedding })
    } catch (e) {
      console.warn(`Failed to process face ${i}:`, e)
    }
  }

  return results
}

/**
 * 增量匹配：为一张新脸找到最合适的 person，或创建新 person
 *
 * 算法（Immich 风格）：
 * 1. 用 sqlite-vec ANN 取 top-K 最近的已有脸（O(log N)）
 * 2. 取第一个 distance ≤ 阈值且带 person_id 的候选
 * 3. 找不到则创建新 person
 *
 * 如 ANN 返回空（旧库未 backfill / 维度不匹配），退回 JS 全量扫。
 *
 * 阈值说明：sqlite-vec 默认对 L2-normalized 向量返回 L2 距离；
 *   ||a - b||² = 2(1 - cos(a,b))   →   d_L2 = √(2(1 - cos))
 * 对 cos=0.4（旧阈值对应的相似度），d_L2 ≈ 1.095 — 我们仍沿用 0.6
 * 作为 cosine 距离阈值，对 ANN 候选先按 L2 升序取，再换算到 cos
 * 距离比较，保持与历史行为一致。
 */
export function assignFaceToPerson(
  db: DatabaseInstance,
  faceId: number,
  embedding: Float32Array
): number {
  const candidates = db.searchFaceKnn(embedding, 10, faceId)

  let best: { personId: number | null; cosDistance: number } | null = null

  if (candidates.length > 0) {
    // 把 vec0 的 L2 距离换成 cos 距离（公式见 ./distance.ts）
    for (const c of candidates) {
      const cosDistance = l2ToCosineDistance(c.distance)
      if (cosDistance > MAX_DISTANCE) break // 已按 L2 升序，余下只会更远
      if (c.personId != null) {
        best = { personId: c.personId, cosDistance }
        break
      }
    }
  } else {
    // ANN 不可用 → 退回原始 JS 全量扫
    best = bruteForceNearest(db, faceId, embedding)
  }

  if (best && best.personId != null && best.cosDistance <= MAX_DISTANCE) {
    db.setFacePersonId(faceId, best.personId)
    db.updatePersonFaceCount(best.personId)
    return best.personId
  }

  const personId = db.createPerson(faceId)
  db.setFacePersonId(faceId, personId)
  return personId
}

/** O(N) 兜底路径：仅在 face_vecs 不可用时触发。 */
function bruteForceNearest(
  db: DatabaseInstance,
  faceId: number,
  embedding: Float32Array
): { personId: number | null; cosDistance: number } | null {
  const allFaces = db.getAllFaceEmbeddings()
  let bestPersonId: number | null = null
  let bestCos = Infinity
  for (const existing of allFaces) {
    if (existing.id === faceId) continue
    const cosDistance = 1 - dot(embedding, existing.embedding)
    if (cosDistance < bestCos) {
      bestCos = cosDistance
      bestPersonId = existing.personId ?? null
    }
  }
  if (bestPersonId === null) return null
  return { personId: bestPersonId, cosDistance: bestCos }
}

/**
 * 裁剪人脸缩略图
 */
export async function getFaceThumbnail(
  imageBuffer: Buffer,
  bbox: FaceBbox,
  size: number = 80
): Promise<Buffer> {
  return cropFace(imageBuffer, bbox, size)
}
