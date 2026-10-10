/**
 * 悬停拖动预览用的 sprite 图：在全片均匀取 SPRITE_FRAMES 帧，居中裁成正方形后横向拼成一张 JPEG。
 *
 * 网格卡片是正方形 object-cover，tile 也裁成正方形，渲染端只要
 *   background-size: N×100% 100%; background-position-x: idx/(N-1)
 * 就能按鼠标横坐标换帧，不用知道视频宽高比。
 *
 * 每帧单独 -ss 快速 seek（走 extractKeyframes，macOS 上优先 VideoToolbox），
 * 不用 fps=N/duration 一次过：那要解完整部片，长视频慢几个数量级。
 */

import sharp from 'sharp'
import { mkdir, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { extractKeyframes } from './extract'

/** 帧数：鼠标扫过一张 200px 的卡片，每 ~16px 换一帧 */
export const SPRITE_FRAMES = 12
/** 更短的片段（实拍里有 0.2s 的误触视频）抽不出 12 个不同时间点，也没必要拖动预览 */
export const SPRITE_MIN_DURATION_MS = 2000
/** 每帧边长（px）：卡片最大 320pt，悬停拖动时略糊可以接受，整张 ~120KB */
export const SPRITE_TILE = 240

export async function generateSprite(videoPath: string, durationMs: number, outPath: string): Promise<void> {
  if (durationMs <= 0) throw new Error('duration unknown')
  const tiles: Buffer[] = []
  for (let k = 0; k < SPRITE_FRAMES; k++) {
    // 取每一格的中点，避开片头黑场和片尾
    const sec = ((k + 0.5) / SPRITE_FRAMES) * (durationMs / 1000)
    const frames = await extractKeyframes(videoPath, {
      startSec: sec, durationSec: 1, intervalSec: 1, maxFrames: 1, maxSide: SPRITE_TILE * 2,
    })
    const src = frames[0]?.buffer ?? tiles[tiles.length - 1]
    if (!src) continue
    tiles.push(frames[0]
      ? await sharp(src).resize(SPRITE_TILE, SPRITE_TILE, { fit: 'cover' }).jpeg().toBuffer()
      : src)
  }
  // 片头几帧都失败时拿不到兜底，只要有一帧就补齐，保证格数固定
  if (tiles.length === 0) throw new Error('no frames decoded')
  while (tiles.length < SPRITE_FRAMES) tiles.push(tiles[tiles.length - 1])

  const sheet = await sharp({
    create: { width: SPRITE_TILE * SPRITE_FRAMES, height: SPRITE_TILE, channels: 3, background: '#000' },
  })
    .composite(tiles.map((input, k) => ({ input, left: k * SPRITE_TILE, top: 0 })))
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer()

  // 先写临时文件再改名：渲染端并发请求时不会读到半张图
  await mkdir(dirname(outPath), { recursive: true })
  const tmp = `${outPath}.${process.pid}.tmp`
  await writeFile(tmp, sheet)
  await rename(tmp, outPath)
}

// 按需生成（老视频没有 sprite）：同一视频只生成一次，且全局串行，悬停扫过一排卡片不会同时起十个 ffmpeg
const inflight = new Map<string, Promise<void>>()
let chain: Promise<unknown> = Promise.resolve()

export function ensureSprite(videoPath: string, durationMs: number, outPath: string): Promise<void> {
  const existing = inflight.get(outPath)
  if (existing) return existing
  const job = chain.then(() => generateSprite(videoPath, durationMs, outPath))
  chain = job.catch(() => {})
  inflight.set(outPath, job)
  job.finally(() => inflight.delete(outPath)).catch(() => {})
  return job
}
