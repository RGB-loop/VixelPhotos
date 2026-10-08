import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
import type { SearchResult } from '../../../shared/types'
import { MediaCard } from './media/MediaCard'
import { mediaKindOf } from '../lib/format'

interface PhotoGridProps {
  results: SearchResult[]
  onSelect: (result: SearchResult) => void
  isSearching?: boolean
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

function countLine(results: SearchResult[]): string {
  const n = { image: 0, video: 0, audio: 0 }
  for (const r of results) n[mediaKindOf(r.photo)]++
  const parts: string[] = []
  if (n.image) parts.push(`${n.image} 张照片`)
  if (n.video) parts.push(`${n.video} 个视频`)
  if (n.audio) parts.push(`${n.audio} 个音频`)
  return parts.join(' · ')
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

  const handleSelect = useCallback((result: SearchResult) => onSelect(result), [onSelect])
  const summary = useMemo(() => countLine(results), [results])

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
          <MediaCard
            result={result}
            onClick={() => handleSelect(result)}
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
              {summary}
            </div>
          )}
        </>
      )}
    </div>
  )
}
