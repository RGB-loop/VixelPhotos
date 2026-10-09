/**
 * FaceService：人脸检测 + embedding + 质量评分 + 即时归属
 *
 * 新脸入库时只做严格的即时归属（assignFaceToPerson），拿不准的留空，
 * 由 ./clusterer.ts 批量聚类成人物（算法见 ./cluster.ts）。
 * 已归属的脸不会被自动移动，用户命名 / 手动整理永远保留。
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { initDetection, isDetectionReady, detectFaces } from './detection'
import { initFaceEmbedding, isEmbeddingReady, embedFace } from './embedding'
import { alignFace, cropFace, type RawImage } from './alignment'
import { faceQuality } from './quality'
import { dot, l2ToCosineDistance } from './distance'
import { Q_SEED, T_ASSIGN, T_LINK } from './cluster'
import type { DatabaseInstance } from '../db'
import type { FaceBbox } from '../../shared/types'
import { getInferenceTransport, RemoteReady } from '../inference/transport'
import sharp from 'sharp'

/** 检测 / 对齐 / 模型任一变化导致旧 embedding 不可比时递增，启动时会清空重扫 */
export const FACE_PIPELINE_VERSION = '3'

let initialized = false
let initializing = false
let _modelsDir: string = ''
const remote = new RemoteReady()

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
  const t = getInferenceTransport()
  if (t) {
    if (remote.isReady(t)) return true
    const ok = await t.call<boolean>('face.init', getModelsDir())
    remote.mark(t, ok)
    return ok
  }
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
  const t = getInferenceTransport()
  if (t) return remote.isReady(t)
  return initialized && isDetectionReady() && isEmbeddingReady()
}

export interface DetectedFaceResult {
  faceIndex: number
  bbox: FaceBbox
  confidence: number
  embedding: Float32Array
  /** 0–1，见 ./quality.ts */
  quality: number
}

/**
 * 处理单张照片的人脸检测 + embedding + 质量评分
 */
export async function processPhotoFaces(
  imageBuffer: Buffer
): Promise<DetectedFaceResult[]> {
  const t = getInferenceTransport()
  if (t) {
    if (!remote.isReady(t) && !(await initFaceService())) throw new Error('Face service not ready')
    return t.call<DetectedFaceResult[]>('face.process', imageBuffer)
  }
  if (!isFaceServiceReady()) {
    throw new Error('Face service not ready')
  }

  const img = await decodeForFaces(imageBuffer)
  const detected = await detectFaces(img)
  if (detected.length === 0) return []

  const results: DetectedFaceResult[] = []

  for (let i = 0; i < detected.length; i++) {
    const face = detected[i]
    try {
      const alignedRaw = alignFace(img, face.landmarks)
      const embedding = await embedFace(alignedRaw)
      const q = faceQuality(face.bbox, face.landmarks, img.width, img.height, alignedRaw)
      results.push({ faceIndex: i, bbox: face.bbox, confidence: face.confidence, embedding, quality: q.score })
    } catch (e) {
      console.warn(`Failed to process face ${i}:`, e)
    }
  }

  return results
}

// 检测只看 640 输入，对齐出 112×112：解码到 2048 足够，省掉 4800 万像素原图的内存和时间
const FACE_DECODE_MAX = 2048

/** 按 EXIF 摆正 + 限制尺寸 + 统一成 3 通道 sRGB（灰度图 raw 只有 1 通道） */
export async function decodeForFaces(imageBuffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(imageBuffer)
    .rotate()
    .resize(FACE_DECODE_MAX, FACE_DECODE_MAX, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * 入库即时归属（严格）：只在很确定时直接归入现有人物，否则留空交给批量聚类（./clusterer.ts）。
 *
 * KNN 取 10 个最近的已有脸，相似度 ≥ T_LINK 且已有归属的按人物投票；
 * 得票最多的人物再用质心复核一次（≥ T_ASSIGN），防止被一两张错归的脸带偏。
 * 不再"找不到就新建人物" —— 那正是一人多簇、路人成堆的来源。
 */
export function assignFaceToPerson(
  db: DatabaseInstance,
  faceId: number,
  embedding: Float32Array,
  quality: number
): number | null {
  if (quality < Q_SEED) return null
  const votes = new Map<number, number>()
  for (const c of db.searchFaceKnn(embedding, 10, faceId)) {
    const sim = 1 - l2ToCosineDistance(c.distance)
    if (sim < T_LINK) break // 已按距离升序
    if (c.personId != null) votes.set(c.personId, (votes.get(c.personId) ?? 0) + sim)
  }
  if (votes.size === 0) return null
  const [personId] = [...votes].sort((a, b) => b[1] - a[1])[0]
  const person = db.getPersonCentroids({ includeHidden: true }).find((p) => p.id === personId)
  if (!person || dot(embedding, person.centroid) < T_ASSIGN) return null
  db.addFaceToPerson(faceId, personId, embedding)
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
