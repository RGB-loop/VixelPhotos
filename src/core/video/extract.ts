/**
 * 视频抽帧 —— 用 ffmpeg-static 提供的 ffmpeg 二进制按固定间隔取关键帧。
 *
 * 设计取舍：
 *   - 用临时目录 + image2 输出文件而非 image2pipe 管道。管道方案要自己
 *     按 SOI/EOI 切 JPEG 流，对一个个人相册产品不值得。
 *   - 抽帧间隔固定 (默认 5s 一帧，上限 20 帧)，不做 scene detection。
 *     scene detection 对静态长视频会返回 0 帧；固定间隔行为可预测。
 *   - 不读 video 时长（避免 ffprobe 依赖）；ffmpeg 自然在视频结束时停止。
 *
 * 失败模式：找不到 ffmpeg 二进制 / ffmpeg 退出非 0 → 抛错；indexer
 * 把该任务标记 error，跳过该视频。
 */

import { spawn } from 'child_process'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ExtractedFrame, ExtractOptions } from './types'

export type { ExtractedFrame, ExtractOptions } from './types'

// ffmpeg-static 在 install 时把二进制放到包目录；require() 返回路径或 null
let ffmpegPath: string | null | undefined
function getFfmpegPath(): string | null {
  if (ffmpegPath === undefined) {
    try {
      // 用 eval require 避免被 bundler 静态分析时尝试解析（electron-vite 期间）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ffmpegPath = (require('ffmpeg-static') as string | null) || null
    } catch {
      ffmpegPath = null
    }
  }
  return ffmpegPath
}

export function isFfmpegAvailable(): boolean {
  return getFfmpegPath() !== null
}

/**
 * 对单个视频文件抽取关键帧。
 *
 * 返回按时间升序的帧数组。出错 / 找不到 ffmpeg → 抛错。
 */
export async function extractKeyframes(
  videoPath: string,
  options: ExtractOptions = {}
): Promise<ExtractedFrame[]> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not available (ffmpeg-static package missing or unsupported platform)')
  }

  const intervalSec = options.intervalSec ?? 5
  const maxFrames = options.maxFrames ?? 20
  const maxSide = options.maxSide ?? 512

  const dir = await mkdtemp(join(tmpdir(), 'vixel-frames-'))
  try {
    // -vf 解释：
    //   select='not(mod(t,N))'  -- 每 N 秒选一帧（基于显示时间戳）
    //   scale=W:H:force_original_aspect_ratio=decrease -- 长边 W，等比缩小，不放大
    //
    // -vsync vfr 保证抽出来的帧时间戳不被复制（select filter 配合用）
    const vf = `select='not(mod(t\\,${intervalSec}))',scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`

    await runFfmpeg(ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', videoPath,
      '-vf', vf,
      '-vsync', 'vfr',
      '-frames:v', String(maxFrames),
      '-f', 'image2',
      join(dir, 'f_%04d.jpg'),
    ])

    const files = (await readdir(dir))
      .filter((f) => f.startsWith('f_') && f.endsWith('.jpg'))
      .sort()

    const frames: ExtractedFrame[] = []
    for (let i = 0; i < files.length; i++) {
      const buffer = await readFile(join(dir, files[i]))
      frames.push({
        buffer,
        // 帧 i 对应原视频的 (i * intervalSec) 秒；select 过滤器是按 t 整数倍
        timestampMs: i * intervalSec * 1000,
      })
    }
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 500) || 'no stderr'}`))
    })
  })
}
