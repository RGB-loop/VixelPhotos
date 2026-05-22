/**
 * 统一图像解码：保证 indexer 拿到的永远是 sharp 能直接消化的 buffer。
 *
 * 解码策略（首个成功为准）：
 *
 *   1. sharp 本身。覆盖 JPEG / PNG / WebP / GIF / TIFF / BMP / AVIF
 *      （也许还有 HEIC，取决于本地 libvips 是否带 libheif）
 *   2. macOS `sips`：覆盖 HEIC / HEIF / CR2 / CR3 / NEF / ARW / DNG /
 *      RAF / ORF / RW2 等系统编解码器支持的格式
 *
 * 非 macOS 平台目前 RAW / HEIC 不可用，调用方需要处理 decode 失败的
 * 情况（一般是把照片标记为 error 跳过）。这是 PRD v0.2 的限制，未来
 * 可加 heic-convert + libraw-wasm 兜底。
 */

import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import sharp from 'sharp'

export interface DecodedImage {
  /** sharp 可直接消化的 buffer（HEIC/RAW 会被转成 JPEG） */
  buffer: Buffer
  /**
   * 原始文件字节。对 EXIF/GPS 提取有用 —— exifr 能直接读 HEIC/RAW 元数据，
   * 转码后的 JPEG 反而会丢拍摄设备 / GPS 等关键字段。
   * 对 passthrough 路径，buffer === originalBuffer（同一 Buffer 引用）。
   */
  originalBuffer: Buffer
  /** 解码来源，便于日志和测试 */
  source: 'passthrough' | 'sips'
  /** 原始扩展名（含 .），全小写 */
  ext: string
}

// 走 sips 兜底的扩展白名单；其它格式 sharp 失败就直接报错
const SIPS_EXTS = new Set<string>([
  '.heic', '.heif',
  '.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2',
])

/**
 * 解码任意路径上的图片为 sharp 友好的 buffer。
 *
 * 注意：从磁盘读 → 验证 → 必要时落临时文件给 sips → 读回结果，
 * 比 readFile + sharp(buffer) 多一次 IO，但只对 HEIC/RAW 走这条路。
 */
export async function decodeImage(filePath: string): Promise<DecodedImage> {
  const ext = extname(filePath).toLowerCase()
  const originalBuffer = await readFile(filePath)

  // 1) sharp 直接试
  try {
    await sharp(originalBuffer).metadata()
    return { buffer: originalBuffer, originalBuffer, source: 'passthrough', ext }
  } catch {
    /* fall through */
  }

  // 2) 仅在白名单格式 + macOS 上走 sips
  if (process.platform === 'darwin' && SIPS_EXTS.has(ext)) {
    const jpeg = await decodeWithSips(originalBuffer, ext)
    return { buffer: jpeg, originalBuffer, source: 'sips', ext }
  }

  throw new Error(
    `Cannot decode image ${filePath} (ext=${ext}) — sharp failed and ` +
      (process.platform === 'darwin'
        ? 'no sips fallback registered for this format'
        : `RAW/HEIC fallback is macOS-only on this platform (${process.platform})`)
  )
}

/**
 * 把图片用 macOS 的 sips 转成 JPEG buffer。需要 sips 在 PATH 上（系统自带）。
 */
async function decodeWithSips(input: Buffer, ext: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'vixel-decode-'))
  const inPath = join(dir, `in${ext}`)
  const outPath = join(dir, 'out.jpg')

  try {
    await writeFile(inPath, input)
    await runSips([
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '85',
      inPath,
      '--out', outPath,
    ])
    return await readFile(outPath)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runSips(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sips', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`sips exited ${code}: ${stderr.trim() || 'no stderr'}`))
    })
  })
}

/**
 * 测试探针：暴露白名单 + 平台支持判断给 unit test，不导出内部细节。
 */
export const __internal = {
  isSipsFallbackFormat(ext: string): boolean {
    return SIPS_EXTS.has(ext.toLowerCase())
  },
  isPlatformSupportedForRaw(): boolean {
    return process.platform === 'darwin'
  },
}
