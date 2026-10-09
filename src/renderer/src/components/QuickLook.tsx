import { useEffect, useState } from 'react'
import type { MediaDetail, SearchResult } from '../../../shared/types'
import { MediaPlayer } from './media/MediaPlayer'
import { mediaKindOf } from '../lib/format'
import { thumbUrl } from '../lib/mediaUrl'

interface QuickLookProps {
  result: SearchResult
  onClose: () => void
  /** 方向键：←→ ±1，↑↓ ±一行（由父组件换算） */
  onNavigate: (key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown') => void
  onOpen: () => void
}

/**
 * 快速查看（Space）：盖在网格上的轻量预览，再按 Space / Esc 关闭，方向键换项。
 * 键盘在捕获阶段截获并停止传播——否则 Space 会同时被 MediaPlayer 当成播放/暂停、
 * 被 App 当成再次打开。J / L / M 不拦，留给播放器。
 */
export function QuickLook({ result, onClose, onNavigate, onOpen }: QuickLookProps): JSX.Element {
  const { photo, segment } = result
  const kind = mediaKindOf(photo)
  const isMedia = kind !== 'image' && photo.videoId != null
  const [media, setMedia] = useState<MediaDetail | null>(null)

  useEffect(() => {
    setMedia(null)
    if (!isMedia || photo.videoId == null) return
    let cancelled = false
    window.api.getMediaDetail(photo.videoId).then((m) => { if (!cancelled) setMedia(m) })
    return () => { cancelled = true }
  }, [isMedia, photo.videoId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      if (k === ' ' || k === 'Escape') onClose()
      else if (k === 'Enter') onOpen()
      else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') onNavigate(k)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onNavigate, onOpen])

  return (
    <div
      className="theme-dark fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-16 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      data-quicklook
    >
      <div className="max-w-full max-h-full w-[min(1100px,100%)] h-full flex flex-col gap-3 pointer-events-none">
        <div className="flex-1 min-h-0 flex items-center justify-center pointer-events-auto">
          {isMedia ? (
            media ? (
              <MediaPlayer key={`${media.id}-${segment?.startMs ?? ''}`} media={media} posterPhotoId={photo.id} posterHash={photo.fileHash} hit={segment} />
            ) : (
              <img src={thumbUrl(photo)} alt={photo.fileName} className="max-w-full max-h-full object-contain rounded-lg opacity-60" />
            )
          ) : (
            <img
              src={`vixel://image/${photo.id}`}
              alt={photo.fileName}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            />
          )}
        </div>
        <div className="text-center flex-shrink-0">
          <p className="text-body text-ink truncate">{photo.fileName}</p>
          <p className="text-caption text-ink-4 mt-0.5">Space 关闭 · ↩ 打开 · 方向键切换</p>
        </div>
      </div>
    </div>
  )
}
