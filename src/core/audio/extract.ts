/**
 * 音频解码 —— 从视频/音频文件提取 mono 16kHz Float32Array
 *
 * 用 ffmpeg-static 提供的 ffmpeg 二进制，直出 f32le 格式到 stdout。
 * 输出格式匹配 EmbeddingGemma 2 audio encoder 的要求：
 *   - 单声道 (mono)
 *   - 16 kHz 采样率
 *   - 小端 float32
 *
 * 使用场景：
 *   - 视频片段：抽取对应时间段的音轨（startSec + durationSec）
 *   - 纯音频文件：全量提取（startSec/durationSec 省略）
 */

import { spawn } from 'child_process'
import { FFMPEG_THREADS, lowerPriority } from '../video/extract'

// 复用 video/extract.ts 的 ffmpeg 路径获取逻辑
let ffmpegPath: string | null | undefined
function getFfmpegPath(): string | null {
  if (ffmpegPath === undefined) {
    try {
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

export interface ExtractAudioOptions {
  /** 起始时间（秒），省略则从头开始 */
  startSec?: number
  /** 持续时长（秒），省略则提取到文件末尾 */
  durationSec?: number
}

/**
 * 提取音频为 mono 16kHz Float32Array。
 *
 * 出错 / 找不到 ffmpeg → 抛错。
 * 视频无音轨 → 返回长度为 0 的 Float32Array（不抛错，允许静音视频）。
 */
export async function extractAudioTrack(
  filePath: string,
  options: ExtractAudioOptions = {}
): Promise<Float32Array> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not available (ffmpeg-static package missing or unsupported platform)')
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-threads', String(FFMPEG_THREADS)]

  // 起始时间（-ss 放在 -i 前，seek 更快）
  if (options.startSec !== undefined && options.startSec > 0) {
    args.push('-ss', String(options.startSec))
  }

  args.push('-i', filePath)

  // 持续时长
  if (options.durationSec !== undefined && options.durationSec > 0) {
    args.push('-t', String(options.durationSec))
  }

  // -vn: 禁视频流
  // -ac 1: 单声道
  // -ar 16000: 16kHz 采样率
  // -f f32le: 小端 float32 PCM
  // -: 输出到 stdout
  args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-')

  const { buffer, exitCode, stderr } = await runFfmpegToBuffer(ffmpeg, args)

  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited ${exitCode}: ${stderr.slice(0, 500) || 'no stderr'}`)
  }

  // buffer 是 raw f32le bytes，4 字节一个 float32
  if (buffer.length === 0) {
    // 视频无音轨 / 静音 → 返回空数组，不算错误
    return new Float32Array(0)
  }

  // Buffer → Float32Array（共享底层 ArrayBuffer）
  const float32 = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 4
  )

  return float32
}

// 5 分钟硬上限（复用 video/extract.ts 的策略）
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000

interface FfmpegResult {
  buffer: Buffer
  exitCode: number
  stderr: string
}

function runFfmpegToBuffer(bin: string, args: string[]): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    lowerPriority(child.pid)
    const chunks: Buffer[] = []
    let stderr = ''
    let timedOut = false

    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, FFMPEG_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`))
      } else {
        resolve({
          buffer: Buffer.concat(chunks),
          exitCode: code ?? -1,
          stderr: stderr.trim(),
        })
      }
    })
  })
}
