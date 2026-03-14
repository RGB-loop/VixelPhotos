import { useCallback, useState, useEffect } from 'react'
import type { SearchResult, Photo } from '../../../shared/types'

interface PhotoGridProps {
  results: SearchResult[]
  onSelect: (photo: Photo) => void
  isSearching?: boolean  // 是否正在搜索（用于决定是否显示相关性分数）
}

interface PhotoCardProps {
  result: SearchResult
  onClick: () => void
  showScore?: boolean
  rank?: number  // 排名（1-based）
}

function PhotoCard({ result, onClick, showScore, rank }: PhotoCardProps): JSX.Element {
  const [thumbnailUrl, setThumbnailUrl] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let mounted = true

    const loadThumbnail = async (): Promise<void> => {
      try {
        const dataUrl = await window.api.getThumbnailData(result.photo.id)
        if (mounted) {
          if (dataUrl) {
            setThumbnailUrl(dataUrl)
            setIsLoading(false)
          } else {
            setError(true)
            setIsLoading(false)
          }
        }
      } catch (err) {
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

  return (
    <div
      className="photo-card relative aspect-square rounded-lg overflow-hidden cursor-pointer bg-gray-100 dark:bg-gray-800"
      onClick={onClick}
    >
      {isLoading ? (
        <div className="absolute inset-0 image-placeholder" />
      ) : error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200 dark:bg-gray-700">
          <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
      ) : (
        <img
          src={thumbnailUrl}
          alt={result.photo.fileName}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
      )}

      {/* 悬浮信息 */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 hover:opacity-100 transition-opacity">
        <div className="absolute bottom-0 left-0 right-0 p-2">
          <p className="text-white text-sm truncate">{result.photo.fileName}</p>
          {result.photo.caption && (
            <p className="text-white/80 text-xs truncate">{result.photo.caption}</p>
          )}
        </div>
      </div>

      {/* 搜索排名和相关性 */}
      {showScore && rank && (
        <div className="absolute top-2 left-2 right-2 flex justify-between items-start pointer-events-none">
          {/* 排名 */}
          <div className="px-1.5 py-0.5 rounded bg-primary-500/90 text-white text-xs font-medium">
            #{rank}
          </div>
          {/* 相关性条 */}
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/50">
            <div className="w-12 h-1.5 bg-white/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-400 rounded-full transition-all"
                style={{ width: `${Math.min(result.score * 100, 100)}%` }}
              />
            </div>
            <span className="text-white text-xs">{(result.score * 100).toFixed(0)}%</span>
          </div>
        </div>
      )}
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
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {results.map((result, index) => (
          <PhotoCard
            key={result.photo.id}
            result={result}
            onClick={() => handleSelect(result.photo)}
            showScore={isSearching}
            rank={index + 1}
          />
        ))}
      </div>

      {results.length > 0 && (
        <div className="text-center text-gray-500 dark:text-gray-400 py-4 text-sm">
          共 {results.length} 张照片
        </div>
      )}
    </div>
  )
}
