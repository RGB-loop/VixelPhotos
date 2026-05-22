import { useCallback, useState, useEffect, useRef, useMemo, memo } from 'react'
// note: useRef + useEffect are still used by the outer PhotoGrid (ResizeObserver).
// PhotoCard's old thumbnail-loading state has been replaced by <img> onLoad/onError.
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
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
}

/**
 * 按容器宽度选列数。和原来 Tailwind 响应式断点对齐
 * (grid-cols-3 sm:4 md:5 lg:6 xl:8)。
 */
function columnsForWidth(w: number): number {
  if (w >= 1280) return 8
  if (w >= 1024) return 6
  if (w >= 768) return 5
  if (w >= 640) return 4
  return 3
}

function StatusBadge({ photo }: { photo: Photo }): JSX.Element | null {
  // v0.2：caption 不再自动生成，badge 仅对未完成的 embedding 显示
  if (photo.embedStatus === 'done') return null
  return (
    <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 pointer-events-none">
      <span className="flex items-center gap-0.5 px-1 py-0.5 rounded bg-black/60 text-[9px] text-amber-300/80">
        <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
        Embedding
      </span>
    </div>
  )
}

const PhotoCard = memo(function PhotoCard({
  result, onClick, showScore, rank,
}: PhotoCardProps): JSX.Element {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // 走 vixel:// 自定义协议，Chromium 直接 fetch 缩略图文件 — 不再走
  // base64-over-IPC。错误状态依靠 <img> 的 onError 监听。
  // 加 photo.id 作为 cache-buster 的一部分：当照片重新生成缩略图（更新文件
  // hash）时，<img> 自然会重新加载（key 变 → src 变）。
  const thumbnailUrl = `vixel://thumb/${result.photo.id}`

  return (
    <div
      className="photo-card relative aspect-square overflow-hidden cursor-pointer bg-surface-2"
      onClick={onClick}
    >
      {!loaded && !error && (
        <div className="absolute inset-0 image-placeholder" />
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-2">
          <svg className="w-6 h-6 text-white/10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
      )}
      {!error && (
        <img
          src={thumbnailUrl}
          alt={result.photo.fileName}
          className={`absolute inset-0 w-full h-full object-cover ${loaded ? 'animate-fade-in' : 'opacity-0'}`}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      )}

      {/* 副本数角标 */}
      {result.photo.duplicateCount && result.photo.duplicateCount > 1 && (
        <div className="absolute top-1.5 right-1.5 px-1 py-0.5 rounded bg-black/60 text-[9px] text-white/70 pointer-events-none">
          {result.photo.duplicateCount} 份
        </div>
      )}

      {/* 搜索排名和相关性 */}
      {showScore && rank && (
        <div className="absolute top-1.5 left-1.5 right-1.5 flex justify-between items-start pointer-events-none">
          <div className="px-1.5 py-0.5 rounded bg-accent/80 text-white text-[10px] font-semibold">
            #{rank}
          </div>
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60">
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

      {/* 处理状态 —— 已经只在可视区域才 render，无需再做 IntersectionObserver */}
      <StatusBadge photo={result.photo} />

      {/* 视频徽章 */}
      {result.photo.videoId != null && (
        <div
          className="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/55 backdrop-blur-sm text-white text-[10px] font-medium pointer-events-none"
          title={`Video frame @ ${formatFrameTime(result.photo.frameTimeMs)}`}
        >
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
          <span>{formatFrameTime(result.photo.frameTimeMs)}</span>
        </div>
      )}

      {/* Hover overlay — 文件名 + caption（用户手写则显示） */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 hover:opacity-100 transition-opacity duration-200">
        <div className="absolute bottom-0 left-0 right-0 p-2.5">
          <p className="text-white text-xs truncate font-medium">{result.photo.fileName}</p>
          {result.photo.caption && (
            <p className="text-white/60 text-[11px] truncate mt-0.5">{result.photo.caption}</p>
          )}
        </div>
      </div>
    </div>
  )
})

function formatFrameTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'video'
  const totalSec = Math.floor(ms / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function PhotoGrid({ results, onSelect, isSearching }: PhotoGridProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // 测量容器宽高；ResizeObserver 比 window.resize 更稳健（侧栏开合也能感知）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const cr = entry.contentRect
      setSize({ w: Math.floor(cr.width), h: Math.floor(cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleSelect = useCallback((photo: Photo) => onSelect(photo), [onSelect])

  const cols = useMemo(() => columnsForWidth(size.w), [size.w])
  // 减 2px 给 gap 留点空间；列宽必须是整数否则 react-window 会出现亚像素抖动
  const cellSize = useMemo(() => (size.w > 0 ? Math.floor(size.w / cols) : 0), [size.w, cols])
  const rowCount = Math.ceil(results.length / cols)

  // 单元渲染：从 grid 坐标反算线性 index
  const Cell = useCallback(
    ({ columnIndex, rowIndex, style }: GridChildComponentProps) => {
      const idx = rowIndex * cols + columnIndex
      if (idx >= results.length) return null
      const result = results[idx]
      return (
        <div style={style}>
          <PhotoCard
            result={result}
            onClick={() => handleSelect(result.photo)}
            showScore={isSearching}
            rank={idx + 1}
          />
        </div>
      )
    },
    [results, cols, handleSelect, isSearching]
  )

  return (
    <div ref={containerRef} className="h-full overflow-hidden p-0.5 flex flex-col">
      {size.w > 0 && size.h > 0 && (
        <>
          <FixedSizeGrid
            // key 让 cols 变化时强制重新挂载，避免内部缓存把错位单元留在原位
            key={`${cols}-${cellSize}`}
            columnCount={cols}
            columnWidth={cellSize}
            rowCount={rowCount}
            rowHeight={cellSize}
            width={size.w}
            // 留出底部 24 px 显示总数
            height={Math.max(0, size.h - 24)}
            overscanRowCount={2}
          >
            {Cell}
          </FixedSizeGrid>
          {results.length > 0 && (
            <div className="h-6 text-center text-white/20 text-xs flex items-center justify-center flex-shrink-0">
              {results.length} 张照片
            </div>
          )}
        </>
      )}
    </div>
  )
}
