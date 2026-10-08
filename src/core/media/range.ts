/**
 * vixel://media 流式播放用的 HTTP Range 解析 + Content-Type 推断。
 *
 * <video>/<audio> 的 seek 依赖 206 Partial Content：Chromium 先发 `bytes=0-`，
 * 拖动进度条时发 `bytes=N-`；moov 在文件尾的 mp4 还会先探测尾部。
 * 只支持单区间 —— 媒体元素从不发多区间请求。
 */

export interface ByteRange {
  start: number
  /** 包含 */
  end: number
}

/**
 * 解析 Range 头。
 *   - 无头 / 非 bytes 单位 / 多区间 → null（调用方回 200 整文件）
 *   - 区间越界 / 语法错 → 'unsatisfiable'（调用方回 416）
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return header.trim().startsWith('bytes=') && !header.includes(',') ? 'unsatisfiable' : null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'

  if (rawStart === '') {
    // 后缀区间 bytes=-N：最后 N 字节
    const suffix = Number(rawEnd)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
}

export function mediaMimeType(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
}
