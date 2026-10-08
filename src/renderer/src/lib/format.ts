import type { MediaKind } from '../../../shared/types'

/** 媒体时长：m:ss，超过一小时 h:mm:ss */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** 剩余 / 已用时间的口语化表示：约 3 分钟、约 1.5 小时 */
export function formatSpan(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

/** 老数据 / 未 JOIN 的查询可能没有 mediaKind：有 videoId 视为视频 */
export function mediaKindOf(photo: { mediaKind?: MediaKind; videoId?: number | null }): MediaKind {
  return photo.mediaKind ?? (photo.videoId != null ? 'video' : 'image')
}

export function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
