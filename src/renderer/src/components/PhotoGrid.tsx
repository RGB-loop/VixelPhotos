import { useCallback, useState, useEffect, useRef } from 'react'
import type { SearchResult, Photo } from '../../../shared/types'

interface PhotoGridProps {
  results: SearchResult[]
  onSelect: (photo: Photo) => void
  isSearching?: boolean
}

interface PhotoCardProps {
  result: SearchResult
  onClick: () => void
  showScore?: boolean
  rank?: number
  index: number
}

function StatusBadge({ photo }: { photo: Photo }): JSX.Element | null {
  const embedDone = photo.embedStatus === 'done'
  const captionDone = photo.captionStatus === 'done'

  // 全部完成则不显示
  if (embedDone && captionDone) return null

  return (
    <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 pointer-events-none">
      {!embedDone && (
        <span className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-black/60 text-[9px] text-amber-300/80">
          <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
          Embedding
        </span>
      )}
      {embedDone && !captionDone && (
        <span className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-black/60 text-[9px] text-purple-300/80">
          <span className="w-1 h-1 rounded-full bg-purple-400 animate-pulse" />
          Caption
        </span>
      )}
    </div>
  )
}

function PhotoCard({ result, onClick, showScore, rank, index }: PhotoCardProps): JSX.Element {
  const [thumbnailUrl, setThumbnailUrl] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)
  const retried = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)

  // IntersectionObserver 追踪可见性
  useEffect(() => {
    const el = cardRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { rootMargin: '100px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let mounted = true

    const loadThumbnail = async (): Promise<void> => {
      try {
        const dataUrl = await window.api.getThumbnailData(result.photo.id)
        if (mounted) {
          if (dataUrl) {
            setThumbnailUrl(dataUrl)
            setIsLoading(false)
          } else if (!retried.current) {
            retried.current = true
            setTimeout(async () => {
              if (!mounted) return
              const retry = await window.api.getThumbnailData(result.photo.id)
              if (mounted) {
                if (retry) {
                  setThumbnailUrl(retry)
                  setIsLoading(false)
                } else {
                  setError(true)
                  setIsLoading(false)
                }
              }
            }, 3000)
          } else {
            setError(true)
            setIsLoading(false)
          }
        }
      } catch {
        if (mounted) {
          setError(true)
          setIsLoading(false)
        }
      }
    }

    loadThumbnail()

    return () => {
      mounted = false
    }
  }, [result.photo.id])

  // 缩略图从 error 状态恢复（photo 数据更新时重试）
  useEffect(() => {
    if (error && result.photo.width) {
      setError(false)
      setIsLoading(true)
      retried.current = false
      window.api.getThumbnailData(result.photo.id).then((dataUrl) => {
        if (dataUrl) {
          setThumbnailUrl(dataUrl)
          setIsLoading(false)
        } else {
          setError(true)
          setIsLoading(false)
        }
      })
    }
  }, [result.photo.width, result.photo.id, error])

  return (
    <div
      ref={cardRef}
      className="photo-card relative aspect-square overflow-hidden cursor-pointer bg-surface-2"
      onClick={onClick}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
    >
      {isLoading ? (
        <div className="absolute inset-0 image-placeholder" />
      ) : error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-2">
          <svg className="w-6 h-6 text-white/10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
      ) : (
        <img
          src={thumbnailUrl}
          alt={result.photo.fileName}
          className="absolute inset-0 w-full h-full object-cover animate-fade-in"
          loading="lazy"
        />
      )}

      {/* 副本数角标 */}
      {result.photo.duplicateCount && result.photo.duplicateCount > 1 && (
        <div className="absolute top-1.5 right-1.5 px-1 py-0.5 rounded bg-black/60 text-[9px] text-white/70 pointer-events-none">
          {result.photo.duplicateCount} 份
        </div>
      )}

      {/* 处理状态 — 仅对可视区域内未完成的照片显示 */}
      {isVisible && <StatusBadge photo={result.photo} />}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 hover:opacity-100 transition-opacity duration-200">
        <div className="absolute bottom-0 left-0 right-0 p-2.5">
          <p className="text-white text-xs truncate font-medium">{result.photo.fileName}</p>
          {result.photo.caption && (
            <p className="text-white/60 text-[11px] truncate mt-0.5">{result.photo.caption}</p>
          )}
        </div>

        {showScore && rank && (
          <div className="absolute top-2 left-2 right-2 flex justify-between items-start">
            <div className="px-1.5 py-0.5 rounded bg-accent/80 text-white text-[10px] font-semibold">
              #{rank}
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/50">
              <div className="w-8 h-1 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${Math.min(result.score * 100, 100)}%` }}
                />
              </div>
              <span className="text-white/80 text-[10px]">{(result.score * 100).toFixed(0)}%</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function PhotoGrid({ results, onSelect, isSearching }: PhotoGridProps): JSX.Element {
  const handleSelect = useCallback(
    (photo: Photo) => {
      onSelect(photo)
    },
    [onSelect]
  )

  return (
    <div className="h-full overflow-auto p-0.5">
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-0.5">
        {results.map((result, index) => (
          <PhotoCard
            key={result.photo.id}
            result={result}
            onClick={() => handleSelect(result.photo)}
            showScore={isSearching}
            rank={index + 1}
            index={index}
          />
        ))}
      </div>

      {results.length > 0 && (
        <div className="text-center text-white/20 py-4 text-xs">
          {results.length} 张照片
        </div>
      )}
    </div>
  )
}
