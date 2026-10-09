import { useEffect, useState, useMemo } from 'react'
import type { MediaDetail, SearchResult } from '../../../shared/types'
import { MediaPlayer } from './media/MediaPlayer'
import { Inspector } from './inspector/Inspector'
import { mediaKindOf } from '../lib/format'
import { thumbUrl } from '../lib/mediaUrl'

interface PhotoDetailProps {
  /** 带 segment 的搜索结果：音视频打开时跳到命中片段 */
  result: SearchResult
  /** 当前结果集，用于 ← → 键翻浏览 */
  siblings?: SearchResult[]
  onSelect: (result: SearchResult) => void
  onClose: () => void
}

/**
 * 全屏详情：只负责看大图 / 播放；元数据都在右侧检查器（与主窗口共用）。
 */
export function PhotoDetail({ result, siblings, onSelect, onClose }: PhotoDetailProps): JSX.Element {
  const { photo, segment } = result
  const kind = mediaKindOf(photo)
  const isMedia = kind !== 'image' && photo.videoId != null
  const [media, setMedia] = useState<MediaDetail | null>(null)
  const [resolution, setResolution] = useState<{ w: number; h: number } | null>(null)
  const imageUrl = `vixel://image/${photo.id}`

  useEffect(() => {
    setMedia(null)
    setResolution(null)
    if (!isMedia || photo.videoId == null) return
    let cancelled = false
    window.api.getMediaDetail(photo.videoId).then((m) => { if (!cancelled) setMedia(m) })
    return () => { cancelled = true }
  }, [isMedia, photo.videoId])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  // 当前照片在 siblings 中的位置，决定 ← → 是否可用
  const currentIndex = useMemo(() => {
    if (!siblings) return -1
    return siblings.findIndex((r) => r.photo.id === photo.id)
  }, [siblings, photo.id])
  const hasPrev = currentIndex > 0
  const hasNext = siblings != null && currentIndex >= 0 && currentIndex < siblings.length - 1

  // 键盘导航：← / → 在 siblings 中切换；忽略输入框中的按键
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      // 编辑 caption 时不抢键盘
      // 焦点在原生播放控件上时 ← → 是快进 / 快退，不翻页
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'VIDEO', 'AUDIO'].includes(target.tagName)) return
      if (e.key === 'ArrowLeft' && hasPrev && siblings) {
        e.preventDefault()
        onSelect(siblings[currentIndex - 1])
      } else if (e.key === 'ArrowRight' && hasNext && siblings) {
        e.preventDefault()
        onSelect(siblings[currentIndex + 1])
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [siblings, currentIndex, hasPrev, hasNext, onSelect])

  const handleBackdropClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      className="theme-dark fixed inset-0 bg-black/95 text-ink flex animate-fade-in modal-overlay"
      onClick={handleBackdropClick}
    >
      {/* 图片预览区域 */}
      <div className="flex-1 min-w-0 flex items-center justify-center p-8 relative">
        {isMedia ? (
          media ? (
            <MediaPlayer
              // key：切换到另一个媒体时重建播放器，重新跳到命中片段
              key={`${media.id}-${segment?.startMs ?? ''}`}
              media={media}
              posterPhotoId={photo.id}
              posterHash={photo.fileHash}
              hit={segment}
              onResolution={(w, h) => setResolution({ w, h })}
            />
          ) : (
            <img src={thumbUrl(photo)} alt={photo.fileName} className="max-w-full max-h-full object-contain opacity-60" />
          )
        ) : imageUrl && (
          <img
            src={imageUrl}
            alt={photo.fileName}
            className="max-w-full max-h-full object-contain animate-fade-in"
          />
        )}

        {/* ← → 翻浏览按钮（仅当 siblings 提供且不在边缘时显示） */}
        {hasPrev && siblings && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(siblings[currentIndex - 1]) }}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm flex items-center justify-center transition-colors"
            title="上一个 (←)"
          >
            <svg className="w-5 h-5 text-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        {hasNext && siblings && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(siblings[currentIndex + 1]) }}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm flex items-center justify-center transition-colors"
            title="下一个 (→)"
          >
            <svg className="w-5 h-5 text-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* 位置指示 "3 / 50" */}
        {siblings && currentIndex >= 0 && (
          <div className="absolute top-4 left-4 px-2 py-1 rounded bg-black/40 backdrop-blur-sm text-ink text-caption tabular-nums pointer-events-none">
            {currentIndex + 1} / {siblings.length}
          </div>
        )}
      </div>

      {/* 信息侧栏：与主窗口检查器同一组件 */}
      <div className="w-[272px] flex-shrink-0 bg-sidebar border-l border-line animate-slide-in">
        <Inspector result={result} onSelect={onSelect} onClose={onClose} resolution={resolution} />
      </div>
    </div>
  )
}
