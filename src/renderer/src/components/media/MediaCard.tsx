import { memo, useEffect, useRef, useState } from 'react'
import type { SearchResult } from '../../../../shared/types'
import { formatDuration, mediaKindOf } from '../../lib/format'

interface MediaCardProps {
  result: SearchResult
  onClick: () => void
  showScore?: boolean
  rank?: number
}

// 悬停多久才起播预览：鼠标扫过网格时不应该每格都开一个解码器
const HOVER_PREVIEW_DELAY_MS = 400

export const KindIcon = ({ kind, className = 'w-2.5 h-2.5' }: { kind: 'video' | 'audio'; className?: string }): JSX.Element =>
  kind === 'video' ? (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
  ) : (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
    </svg>
  )

/**
 * 网格卡片：图片 / 视频 / 音频统一入口。
 *   左上 #排名，右上 相关度（仅搜索时）
 *   左下 处理状态 + 副本数；右下 命中时间点 + 类型图标 + 时长
 * 视频悬停 400ms 后从命中片段（无命中则从头）静音播放预览，移开即卸载 <video> 释放解码器。
 */
export const MediaCard = memo(function MediaCard({ result, onClick, showScore, rank }: MediaCardProps): JSX.Element {
  const { photo, segment } = result
  const kind = mediaKindOf(photo)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  const handleEnter = (): void => {
    if (kind !== 'video' || photo.videoId == null) return
    timer.current = setTimeout(() => setPreviewing(true), HOVER_PREVIEW_DELAY_MS)
  }
  const handleLeave = (): void => {
    clearTimeout(timer.current)
    setPreviewing(false)
  }

  const startSec = (segment?.startMs ?? 0) / 1000
  // 音频代表图没有图片向量，embed_status 永远 pending，不能显示"Embedding"
  const embedding = kind !== 'audio' && photo.embedStatus !== 'done'
  const dup = photo.duplicateCount && photo.duplicateCount > 1 ? photo.duplicateCount : 0

  return (
    <div
      className="photo-card relative aspect-square overflow-hidden cursor-pointer bg-surface-2 group"
      onClick={onClick}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {!loaded && !error && <div className="absolute inset-0 image-placeholder" />}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-2 text-ink-4">
          {kind === 'image' ? (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          ) : (
            <KindIcon kind={kind} className="w-7 h-7" />
          )}
        </div>
      ) : (
        <img
          src={`vixel://thumb/${photo.id}`}
          alt={photo.fileName}
          className={`absolute inset-0 w-full h-full object-cover ${loaded ? 'animate-fade-in' : 'opacity-0'}`}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      )}

      {previewing && (
        <video
          src={`vixel://media/${photo.videoId}#t=${startSec}`}
          className="absolute inset-0 w-full h-full object-cover animate-fade-in"
          muted
          autoPlay
          loop
          playsInline
          preload="auto"
        />
      )}

      {/* 音频：居中播放图标，提示点开可播放 */}
      {kind === 'audio' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-9 h-9 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center text-ink opacity-70 group-hover:opacity-100 transition-opacity">
            <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}

      {/* Hover overlay — 文件名 + caption */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
        <div className="absolute bottom-7 left-0 right-0 px-2.5">
          <p className="text-white text-callout truncate font-medium">{photo.fileName}</p>
          {photo.caption && <p className="text-ink-2 text-caption truncate mt-0.5">{photo.caption}</p>}
        </div>
      </div>

      {showScore && rank != null && (
        <>
          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-accent/80 text-white text-micro font-semibold pointer-events-none">
            #{rank}
          </div>
          <div className="absolute top-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 pointer-events-none">
            <div className="w-8 h-1 bg-fill-strong rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(result.score * 100, 100)}%` }} />
            </div>
            <span className="text-ink text-micro">{(result.score * 100).toFixed(0)}%</span>
          </div>
        </>
      )}

      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 pointer-events-none">
        {embedding && (
          <span className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-black/60 text-micro text-warn/80">
            <span className="w-1 h-1 rounded-full bg-warn animate-pulse" />
            Embedding
          </span>
        )}
        {dup > 0 && <span className="px-1 py-0.5 rounded bg-black/60 text-micro text-ink">{dup} 份</span>}
      </div>

      {kind !== 'image' && (
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 pointer-events-none">
          {segment && (
            <span className="px-1.5 py-0.5 rounded-md bg-accent/90 text-white text-micro font-medium tabular-nums">
              命中 {formatDuration(segment.startMs)}
            </span>
          )}
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-white text-micro font-medium tabular-nums">
            <KindIcon kind={kind} />
            {photo.durationMs != null && photo.durationMs > 0 && formatDuration(photo.durationMs)}
          </span>
        </div>
      )}
    </div>
  )
})
