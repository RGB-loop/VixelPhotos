import { memo, useEffect, useRef, useState } from 'react'
import type { SearchResult } from '../../../../shared/types'
import { formatDuration, mediaKindOf } from '../../lib/format'

interface MediaCardProps {
  result: SearchResult
  /** 在网格里的线性位置；回调都带 index，父组件可以传稳定的函数，memo 才有效 */
  index: number
  selected: boolean
  /** 仅搜索时显示排名 */
  rank?: number
  onClick: (index: number, e: React.MouseEvent) => void
  onDoubleClick: (index: number) => void
  onContextMenu: (index: number, e: React.MouseEvent) => void
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
 * 网格卡片：图片 / 视频 / 音频统一入口。四角各有固定职责：
 *   左上 排名（仅搜索）   右上 悬停"⋯"更多操作
 *   左下 命中时间点       右下 类型图标 + 时长
 * 底边细线：悬停预览时是播放进度，否则是命中片段在全长中的位置。
 * 索引状态、副本数、相关度分数不上卡片，放在检查器里。
 * 视频悬停 400ms 后从命中片段（无命中则从头）静音播放预览，移开即卸载 <video> 释放解码器。
 */
export const MediaCard = memo(function MediaCard({
  result, index, selected, rank, onClick, onDoubleClick, onContextMenu,
}: MediaCardProps): JSX.Element {
  const { photo, segment } = result
  const kind = mediaKindOf(photo)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewRatio, setPreviewRatio] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  const handleEnter = (): void => {
    if (kind !== 'video' || photo.videoId == null) return
    timer.current = setTimeout(() => setPreviewing(true), HOVER_PREVIEW_DELAY_MS)
  }
  const handleLeave = (): void => {
    clearTimeout(timer.current)
    setPreviewing(false)
    setPreviewRatio(0)
  }

  const startSec = (segment?.startMs ?? 0) / 1000
  const duration = photo.durationMs ?? 0
  // 命中片段在全长中的位置（0–1）
  const hitSpan = segment && duration > 0
    ? { left: segment.startMs / duration, width: Math.max(0.02, (segment.endMs - segment.startMs) / duration) }
    : null

  return (
    <div
      className="photo-card relative w-full h-full rounded-lg overflow-hidden cursor-default bg-surface-2 group"
      onClick={(e) => onClick(index, e)}
      onDoubleClick={() => onDoubleClick(index)}
      onContextMenu={(e) => onContextMenu(index, e)}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      data-selected={selected || undefined}
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
          onTimeUpdate={(e) => {
            const v = e.currentTarget
            if (v.duration) setPreviewRatio(v.currentTime / v.duration)
          }}
        />
      )}

      {/* 音频：居中播放图标，提示点开可播放 */}
      {kind === 'audio' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-9 h-9 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center text-white/90 opacity-70 group-hover:opacity-100 transition-opacity">
            <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}

      {/* 悬停：文件名 + 描述 */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-fast pointer-events-none">
        <div className="absolute bottom-7 left-0 right-0 px-2.5">
          <p className="text-white/90 text-callout truncate font-medium">{photo.fileName}</p>
          {photo.caption && <p className="text-white/60 text-caption truncate mt-0.5">{photo.caption}</p>}
        </div>
      </div>

      {/* 左上：排名 */}
      {rank != null && (
        <span className="absolute top-1.5 left-1.5 min-w-[18px] h-[18px] px-1 rounded bg-black/60 backdrop-blur-sm text-white/90 text-micro font-semibold tabular-nums flex items-center justify-center pointer-events-none">
          {rank}
        </span>
      )}

      {/* 右上：更多操作 */}
      <button
        onClick={(e) => { e.stopPropagation(); onContextMenu(index, e) }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="更多操作"
        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md bg-black/55 backdrop-blur-sm text-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-black/75 transition-opacity duration-fast"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      {/* 左下：命中时间点 */}
      {segment && (
        <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-accent text-black/85 text-micro font-semibold tabular-nums pointer-events-none">
          {formatDuration(segment.startMs)}
        </span>
      )}

      {/* 右下：类型 + 时长 */}
      {kind !== 'image' && (
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-white/90 text-micro font-medium tabular-nums pointer-events-none">
          <KindIcon kind={kind} />
          {duration > 0 && formatDuration(duration)}
        </span>
      )}

      {/* 底边细线：预览进度 / 命中片段位置 */}
      {previewing ? (
        <div className="absolute bottom-0 inset-x-0 h-[2px] bg-white/15 pointer-events-none">
          <div className="h-full bg-accent" style={{ width: `${previewRatio * 100}%` }} />
        </div>
      ) : hitSpan && (
        <div className="absolute bottom-0 inset-x-0 h-[2px] bg-white/10 pointer-events-none">
          <div className="absolute h-full bg-accent" style={{ left: `${hitSpan.left * 100}%`, width: `${hitSpan.width * 100}%` }} />
        </div>
      )}

      {/* 选中：2px 强调色内描边 */}
      {selected && <div className="absolute inset-0 rounded-lg ring-2 ring-inset ring-accent pointer-events-none" />}
    </div>
  )
})
