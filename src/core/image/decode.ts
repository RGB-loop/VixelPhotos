/**
 * 统一图像解码：保证 indexer 拿到的永远是 sharp 能直接消化的 buffer。
 *
 * 解码策略（首个成功为准）：
 *
 *   1. sharp 本身。覆盖 JPEG / PNG / WebP / GIF / TIFF / BMP / AVIF
 *      （也许还有 HEIC，取决于本地 libvips 是否带 libheif）
 *   2. macOS `sips`：覆盖 HEIC / HEIF / CR2 / CR3 / NEF / ARW / DNG /
 *      RAF / ORF / RW2 等系统编解码器支持的格式
 *   3. `heic-convert`（libheif WASM）：作为 HEIC/HEIF 的跨平台兜底，
 *      Linux / Windows 上替代 sips。比 sips 慢一档但纯 JS 无系统依赖。
 *
 * 非 macOS 的 RAW（CR2/NEF/ARW 等）目前仍不可用 — v0.3+ 计划用
 * libraw-wasm 兜底，调用方需要处理 decode 失败的情况。
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
  source: 'passthrough' | 'sips' | 'embedded-preview' | 'heic-convert'
  /** 原始扩展名（含 .），全小写 */
  ext: string
}

// 走 sips 兜底的扩展白名单；其它格式 sharp 失败就直接报错
const SIPS_EXTS = new Set<string>([
  '.heic', '.heif',
  '.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2',
])

// heic-convert 兜底的扩展白名单（仅 HEIC/HEIF；RAW 走 sips 或 v0.3+ libraw-wasm）
const HEIC_CONVERT_EXTS = new Set<string>([
  '.heic', '.heif',
])

// 懒加载 heic-convert：~5 MB jpeg-js + pngjs + heic-decode wasm，不需要时不付代价
type HeicConvert = (opts: { buffer: Buffer; format: 'JPEG' | 'PNG'; quality?: number }) => Promise<Uint8Array>
let heicConvertCache: HeicConvert | null | undefined
function loadHeicConvert(): HeicConvert | null {
  if (heicConvertCache === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      heicConvertCache = require('heic-convert') as HeicConvert
    } catch {
      heicConvertCache = null
    }
  }
  return heicConvertCache
}

/**
 * 解码任意路径上的图片为 sharp 友好的 buffer。
 *
 * 注意：从磁盘读 → 验证 → 必要时落临时文件给 sips → 读回结果，
 * 比 readFile + sharp(buffer) 多一次 IO，但只对 HEIC/RAW 走这条路。
 */
export async function decodeImage(filePath: string): Promise<DecodedImage> {
  const ext = extname(filePath).toLowerCase()
  const originalBuffer = await readFile(filePath)

  // 1) macOS 上 HEIC / RAW 直接走 sips（系统 codec）。不能先问 sharp：
  //    sharp 读得懂 CR2 / HEIC 的文件头，metadata() 成功，真解码时才失败
  //    （"Old-style JPEG compression not configured" / HEVC 不支持），以前这些文件全部索引失败
  let sipsError: unknown
  if (process.platform === 'darwin' && SIPS_EXTS.has(ext)) {
    try {
      const jpeg = await decodeWithSips(originalBuffer, ext)
      return { buffer: jpeg, originalBuffer, source: 'sips', ext }
    } catch (err) {
      sipsError = err // 再试内嵌预览 / sharp
    }
  }

  // 1.5) RAW 内嵌的相机 JPEG 预览（几乎所有 RAW 都带一张全尺寸预览）：
  //      系统解码失败时兜底；Linux / Windows 没有 sips，这也是它们唯一的 RAW 支持
  if (RAW_EXTS.has(ext)) {
    const preview = await extractEmbeddedJpeg(originalBuffer, ext)
    if (preview) return { buffer: preview, originalBuffer, source: 'embedded-preview', ext }
  }

  // 2) sharp：用一次真解码验证（缩到 32px，JPEG 走 shrink-on-load 很便宜），只读文件头会误判。
  //    failOn 'error'：DNG 之类的非致命元数据警告不算失败
  try {
    await sharp(originalBuffer, { failOn: 'error' }).resize(32, 32, { fit: 'inside' }).raw().toBuffer()
    return { buffer: originalBuffer, originalBuffer, source: 'passthrough', ext }
  } catch {
    /* fall through */
  }
  if (sipsError) throw sipsError

  // 3) 跨平台 HEIC 兜底（libheif via WASM）
  //    Linux/Windows 在这里接住，macOS 上一般用不到（sips 已经在 #2 处理）
  if (HEIC_CONVERT_EXTS.has(ext)) {
    const jpeg = await decodeWithHeicConvert(originalBuffer)
    if (jpeg) {
      return { buffer: jpeg, originalBuffer, source: 'heic-convert', ext }
    }
  }

  throw new Error(
    `Cannot decode image ${filePath} (ext=${ext}) — sharp failed and ` +
      (process.platform === 'darwin'
        ? 'no sips fallback registered for this format'
        : `RAW fallback is macOS-only on this platform (${process.platform}); ` +
          `HEIC fallback requires heic-convert package`)
  )
}

const RAW_EXTS = new Set<string>(['.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2'])

/**
 * 从 RAW 里取相机写入的 JPEG 预览：RAF 头部第 84 字节起是预览的偏移 / 长度（大端）；
 * 其他格式扫描所有 JPEG 起始标记，取能解码的最大一张。都没有返回 null。
 */
async function extractEmbeddedJpeg(buf: Buffer, ext: string): Promise<Buffer | null> {
  const candidates: Buffer[] = []
  if (ext === '.raf' && buf.length > 100 && buf.toString('latin1', 0, 15) === 'FUJIFILMCCD-RAW') {
    const off = buf.readUInt32BE(84), len = buf.readUInt32BE(88)
    if (off > 0 && len > 0 && off + len <= buf.length) candidates.push(buf.subarray(off, off + len))
  }
  if (candidates.length === 0) {
    // 只看 JPEG 起始标记 FF D8 FF，按到下一个起始标记（或文件尾）切；取最大的几段尝试
    const starts: number[] = []
    for (let i = buf.indexOf(0xff); i >= 0 && i < buf.length - 3; i = buf.indexOf(0xff, i + 1)) {
      if (buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) starts.push(i)
    }
    const segs = starts.map((st, k) => buf.subarray(st, starts[k + 1] ?? buf.length))
    candidates.push(...segs.sort((a, b) => b.length - a.length).slice(0, 6))
  }
  // 从大到小试，必须真能解码：Canon CR2 里最大的那段是 12 bit 无损 JPEG（传感器原始数据），
  // 只读文件头会当成预览，解码时报 "Unsupported JPEG data precision 12"
  for (const c of candidates) {
    try {
      const meta = await sharp(c, { failOn: 'none' }).metadata()
      if ((meta.width ?? 0) < 640) continue
      await sharp(c, { failOn: 'error' }).resize(32, 32, { fit: 'inside' }).raw().toBuffer()
      return Buffer.from(c)
    } catch { /* 下一个 */ }
  }
  return null
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

/**
 * 用 heic-convert (libheif WASM) 把 HEIC/HEIF 转 JPEG buffer。
 * heic-convert 不可用（包未安装 / WASM 加载失败）→ 返回 null，调用方继续报错。
 */
async function decodeWithHeicConvert(input: Buffer): Promise<Buffer | null> {
  const convert = loadHeicConvert()
  if (!convert) return null
  try {
    const jpegBytes = await convert({ buffer: input, format: 'JPEG', quality: 0.85 })
    return Buffer.from(jpegBytes)
  } catch (err) {
    console.warn('heic-convert decode failed:', err)
    return null
  }
}

// 30s 上限对单张 HEIC/RAW 解码足够；卡住一般意味着文件损坏或 sips bug
const SIPS_TIMEOUT_MS = 30_000

function runSips(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sips', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, SIPS_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (timedOut) {
        reject(new Error(`sips timed out after ${SIPS_TIMEOUT_MS}ms`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`sips exited ${code}: ${stderr.trim() || 'no stderr'}`))
      }
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
  isHeicConvertFormat(ext: string): boolean {
    return HEIC_CONVERT_EXTS.has(ext.toLowerCase())
  },
  isPlatformSupportedForRaw(): boolean {
    return process.platform === 'darwin'
  },
  /**
   * 返回某个扩展名在当前平台上的可用 fallback 路径，按尝试顺序。
   * 用于测试与诊断；不暴露 sharp passthrough（那是 fallback 之前的快路径）。
   */
  supportedFallbacks(ext: string): Array<'sips' | 'heic-convert'> {
    const e = ext.toLowerCase()
    const out: Array<'sips' | 'heic-convert'> = []
    if (process.platform === 'darwin' && SIPS_EXTS.has(e)) out.push('sips')
    if (HEIC_CONVERT_EXTS.has(e)) out.push('heic-convert')
    return out
  },
}
