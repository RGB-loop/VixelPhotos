/**
 * 视频抽帧 —— 用 ffmpeg-static 提供的 ffmpeg 二进制按固定间隔取关键帧。
 *
 * 设计取舍：
 *   - 用临时目录 + image2 输出文件而非 image2pipe 管道。管道方案要自己
 *     按 SOI/EOI 切 JPEG 流，对一个个人相册产品不值得。
 *   - 抽帧间隔固定（indexer 按 32s 片段 1fps 抽），不做 scene detection。
 *     scene detection 对静态长视频会返回 0 帧；固定间隔行为可预测。
 *   - 时长用 probeDurationMs 解析 `ffmpeg -i` 的 stderr，不依赖 ffprobe。
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
  const startSec = options.startSec ?? 0
  const durationSec = options.durationSec

  const dir = await mkdtemp(join(tmpdir(), 'vixel-frames-'))
  try {
    // -ss: seek to start position (before -i for fast seek)
    // -t: duration to process (if specified)
    // -vf 解释：
    //   select='not(mod(t,N))'  -- 每 N 秒选一帧（基于显示时间戳）
    //   scale=W:H:force_original_aspect_ratio=decrease -- 长边 W，等比缩小，不放大
    //
    // -vsync vfr 保证抽出来的帧时间戳不被复制（select filter 配合用）
    const vf = `select='not(mod(t\\,${intervalSec}))',scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
    ]
    if (startSec > 0) {
      args.push('-ss', String(startSec))
    }
    args.push('-i', videoPath)
    if (durationSec !== undefined) {
      args.push('-t', String(durationSec))
    }
    args.push(
      '-vf', vf,
      '-vsync', 'vfr',
      '-frames:v', String(maxFrames),
      '-f', 'image2',
      join(dir, 'f_%04d.jpg')
    )

    await runFfmpeg(ffmpeg, args)

    const files = (await readdir(dir))
      .filter((f) => f.startsWith('f_') && f.endsWith('.jpg'))
      .sort()

    const frames: ExtractedFrame[] = []
    for (let i = 0; i < files.length; i++) {
      const buffer = await readFile(join(dir, files[i]))
      frames.push({
        buffer,
        // 帧 i 对应片段内的 (i * intervalSec) 秒；select 过滤器是按 t 整数倍。
        // 片段模式下加上 startSec 偏移，使时间戳相对整个视频。
        timestampMs: Math.round((startSec + i * intervalSec) * 1000),
      })
    }
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 读视频时长（毫秒）。ffmpeg-static 不带 ffprobe，所以用 `ffmpeg -i <file>`
 * 不给输出 —— ffmpeg 会以非 0 退出，但 stderr 里有 "Duration: HH:MM:SS.xx"。
 *
 * 读不到时长（直播流 / 损坏文件 / "Duration: N/A"）→ 返回 null。
 */
export async function probeDurationMs(videoPath: string): Promise<number | null> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not available (ffmpeg-static package missing or unsupported platform)')
  }
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', videoPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let buf = ''
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, 30_000)
    child.stderr.on('data', (chunk: Buffer) => { buf += chunk.toString() })
    child.on('error', (err) => { clearTimeout(killTimer); reject(err) })
    child.on('close', () => { clearTimeout(killTimer); resolve(buf) })
  })
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (!m) return null
  const ms = Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000)
  return ms > 0 ? ms : null
}

// 5 分钟硬上限：单片段在 4K H.265 上通常远低于此，
// 但卡住的视频（损坏 / 编解码 deadlock）必须给 indexer 一个逃生窗口
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, FFMPEG_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 500) || 'no stderr'}`))
      }
    })
  })
}
