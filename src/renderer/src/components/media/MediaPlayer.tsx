import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaDetail } from '../../../../shared/types'
import { SegmentTimeline } from './SegmentTimeline'
import { thumbUrl } from '../../lib/mediaUrl'

interface MediaPlayerProps {
  media: MediaDetail
  /** 代表 photo id：视频做 poster，音频做封面 / 波形 */
  posterPhotoId: number
  /** 代表 photo 的 fileHash：thumb URL 缓存参数 */
  posterHash: string
  hit?: { startMs: number; endMs: number }
  onResolution?: (w: number, h: number) => void
}

const JUMP_SEC = 10

/**
 * 应用内播放：视频 <video>，音频 = 封面 / 波形 + <audio>，共用下方片段条。
 * 源文件走 vixel://media/<id>（主进程手写 Range，seek 才可用）。
 *
 * 打开即跳到命中片段并播放。快捷键：Space 播放/暂停，J / L ±10s，M 静音；
 * ← → 留给详情页翻上一个 / 下一个。
 * Chromium 解不了的格式（mkv 里的某些编码、avi 等）→ onError → 回退到系统播放器。
 */
export function MediaPlayer({ media, posterPhotoId, posterHash, hit, onResolution }: MediaPlayerProps): JSX.Element {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const [currentMs, setCurrentMs] = useState(hit?.startMs ?? 0)
  const [failed, setFailed] = useState(false)
  const src = `vixel://media/${media.id}`
  const poster = thumbUrl({ id: posterPhotoId, fileHash: posterHash })

  const seek = useCallback((ms: number) => {
    const el = ref.current
    if (!el) return
    el.currentTime = ms / 1000
    setCurrentMs(ms)
    el.play().catch(() => {})
  }, [])

  const handleLoaded = (): void => {
    const el = ref.current
    if (!el) return
    if (hit && hit.startMs > 0) el.currentTime = hit.startMs / 1000
    if (media.kind === 'video' && el.videoWidth) onResolution?.(el.videoWidth, el.videoHeight)
    el.play().catch(() => {})
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = ref.current
      const target = e.target as HTMLElement | null
      if (!el || (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === ' ') {
        // 媒体元素自己有焦点时原生控件已处理 Space，再切一次会抵消
        if (target === el) return
        e.preventDefault()
        if (el.paused) el.play().catch(() => {})
        else el.pause()
      } else if (key === 'j') {
        el.currentTime = Math.max(0, el.currentTime - JUMP_SEC)
      } else if (key === 'l') {
        el.currentTime = Math.min(el.duration || Infinity, el.currentTime + JUMP_SEC)
      } else if (key === 'm') {
        el.muted = !el.muted
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const common = {
    ref,
    src,
    controls: true,
    preload: 'metadata' as const,
    onLoadedMetadata: handleLoaded,
    onTimeUpdate: () => setCurrentMs((ref.current?.currentTime ?? 0) * 1000),
    onError: () => setFailed(true),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4" onClick={(e) => e.stopPropagation()}>
      <div className="flex-1 min-h-0 w-full flex items-center justify-center relative">
        {failed ? (
          <div className="relative max-w-full max-h-full">
            <img src={poster} alt={media.fileName} className="max-w-full max-h-[70vh] object-contain opacity-40 rounded" />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
              <p className="text-body text-ink">此格式无法在应用内播放</p>
              <button
                onClick={() => window.api.openSourceVideo(media.id)}
                className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent text-callout rounded-md transition-colors"
              >
                在系统播放器中打开
              </button>
            </div>
          </div>
        ) : media.kind === 'video' ? (
          <video {...common} poster={poster} className="max-w-full max-h-full rounded bg-black" />
        ) : (
          <div className="flex flex-col items-center gap-5 w-full max-w-2xl">
            <img src={poster} alt={media.fileName} className="max-h-[50vh] max-w-full object-contain rounded-lg shadow-2xl" />
            <audio {...common} className="w-full" />
          </div>
        )}
      </div>
      {!failed && media.durationMs != null && media.durationMs > 0 && (
        <div className="w-full max-w-3xl flex-shrink-0">
          <SegmentTimeline
            durationMs={media.durationMs}
            segments={media.segments}
            hit={hit}
            currentMs={currentMs}
            onSeek={seek}
          />
          <p className="mt-1.5 text-micro text-ink-3 text-center">Space 播放/暂停 · J / L 后退/前进 10 秒 · M 静音</p>
        </div>
      )}
    </div>
  )
}
