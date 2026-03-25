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
 * 1. 加载所有已有 face embeddings
 * 2. 计算新脸与所有已有脸的余弦距离
 * 3. 找到距离最近的已有脸
 * 4. 如果距离 ≤ MAX_DISTANCE 且该脸有 person_id → 归入同一 person
 * 5. 否则 → 创建新 person
 */
export function assignFaceToPerson(
  db: DatabaseInstance,
  faceId: number,
  embedding: Float32Array
): number {
  const allFaces = db.getAllFaceEmbeddings()

  let bestPersonId: number | null = null
  let bestDistance = Infinity

  for (const existing of allFaces) {
    if (existing.id === faceId) continue // 跳过自身

    // 余弦距离 = 1 - dot(a, b)（已 L2 归一化）
    let dot = 0
    for (let i = 0; i < embedding.length && i < existing.embedding.length; i++) {
      dot += embedding[i] * existing.embedding[i]
    }
    const distance = 1 - dot

    if (distance < bestDistance) {
      bestDistance = distance
      bestPersonId = existing.personId ?? null
    }
  }

  if (bestPersonId !== null && bestDistance <= MAX_DISTANCE) {
    // 归入已有人物
    db.setFacePersonId(faceId, bestPersonId)
    db.updatePersonFaceCount(bestPersonId)
    console.log(`    Face #${faceId} → Person #${bestPersonId} (distance=${bestDistance.toFixed(3)})`)
    return bestPersonId
  }

  // 创建新人物
  const personId = db.createPerson(faceId)
  db.setFacePersonId(faceId, personId)
  console.log(`    Face #${faceId} → New Person #${personId} (nearest distance=${bestDistance.toFixed(3)})`)
  return personId
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
