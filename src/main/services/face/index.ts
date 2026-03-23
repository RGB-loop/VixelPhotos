/**
 * FaceService：人脸检测 + embedding + 聚类的统一入口
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { app } from 'electron'
import { initDetection, isDetectionReady, detectFaces, type DetectedFace } from './detection'
import { initFaceEmbedding, isEmbeddingReady, embedFace } from './embedding'
import { alignFace, cropFace } from './alignment'
import { clusterFaces } from './clustering'
import type { DatabaseInstance } from '../../db'
import type { FaceBbox } from '../../../shared/types'
import sharp from 'sharp'

let initialized = false
let initializing = false

function getModelsDir(): string {
  // 开发环境：resources/models/
  // 生产环境：app.getAppPath() + resources/models/ 或 extraResources
  const devPath = join(process.cwd(), 'resources', 'models')
  if (existsSync(devPath)) return devPath

  const prodPath = join(app.getAppPath(), '..', 'models')
  if (existsSync(prodPath)) return prodPath

  // fallback to resources in app path
  return join(app.getAppPath(), 'resources', 'models')
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
 * 返回检测到的人脸数据
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

  // 获取图片尺寸
  const metadata = await sharp(imageBuffer).metadata()
  const imgW = metadata.width || 1
  const imgH = metadata.height || 1

  // 人脸检测
  const detected = await detectFaces(imageBuffer)

  if (detected.length === 0) return []

  // 对每张脸做对齐 + embedding
  const results: Array<{
    faceIndex: number
    bbox: FaceBbox
    confidence: number
    embedding: Float32Array
  }> = []

  for (let i = 0; i < detected.length; i++) {
    const face = detected[i]

    try {
      // 对齐人脸
      const alignedRaw = await alignFace(imageBuffer, face.landmarks, imgW, imgH)

      // 生成 embedding
      const embedding = await embedFace(alignedRaw)

      results.push({
        faceIndex: i,
        bbox: face.bbox,
        confidence: face.confidence,
        embedding,
      })
    } catch (e) {
      console.warn(`Failed to process face ${i}:`, e)
    }
  }

  return results
}

/**
 * 对数据库中所有人脸 embedding 进行聚类，更新 person 分组
 */
export function runClustering(db: DatabaseInstance): void {
  const allFaces = db.getAllFaceEmbeddings()

  if (allFaces.length === 0) {
    console.log('No faces to cluster')
    return
  }

  console.log(`Clustering ${allFaces.length} faces...`)

  const clusterResult = clusterFaces(allFaces)

  // 将 cluster labels 归一化为连续的 person IDs
  const labelToPersonId = new Map<number, number>()
  const clusterMembers = new Map<number, Array<{ id: number; confidence: number }>>()

  for (const [faceId, label] of clusterResult) {
    if (!clusterMembers.has(label)) {
      clusterMembers.set(label, [])
    }
    const face = allFaces.find((f) => f.id === faceId)
    clusterMembers.get(label)!.push({ id: faceId, confidence: face?.confidence || 0 })
  }

  // 为每个 cluster 创建或复用 person
  db.clearPeopleAndReassign(clusterMembers)

  console.log(`Clustering complete: ${clusterMembers.size} people found`)
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
