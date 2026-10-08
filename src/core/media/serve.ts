/**
 * vixel://media/<id> 的响应体：本地音视频文件 → 200 / 206 / 416。
 */
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname } from 'path'
import { Readable } from 'stream'
import { mediaMimeType, parseRange } from './range'

/**
 * 不用 net.fetch(file://)：它对 Range 的支持不可靠，<video> 拖进度条会从头重下或直接失败。
 * 手写 206：按区间开 ReadStream 转 Web stream。
 */
export async function serveMediaFile(filePath: string, rangeHeader: string | null): Promise<Response> {
  const { size } = await stat(filePath)
  const headers: Record<string, string> = {
    'Content-Type': mediaMimeType(extname(filePath)),
    'Accept-Ranges': 'bytes',
  }
  const range = parseRange(rangeHeader, size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const body = size === 0
    ? null
    : (Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>)
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status: range ? 206 : 200, headers })
}
