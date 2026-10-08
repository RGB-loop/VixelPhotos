import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
import type { SearchResult } from '../../../shared/types'
import { MediaCard } from './media/MediaCard'

/** 卡片间距（px）：每格四周各留一半 */
const GAP = 4

interface PhotoGridProps {
  results: SearchResult[]
  isSearching?: boolean
  /** 目标缩略图边长（px），由状态栏滑块控制；实际列宽按容器宽度取整均分 */
  thumbSize: number
  selectedIds: Set<number>
  /** 键盘焦点所在 index；变化时滚动到可见 */
  focusIndex: number
  onItemClick: (index: number, e: React.MouseEvent) => void
  onItemOpen: (index: number) => void
  onItemContextMenu: (index: number, e: React.MouseEvent) => void
  /** 上报列数：方向键 ↑ ↓ 按行移动要用 */
  onColsChange: (cols: number) => void
}

export function PhotoGrid({
  results, isSearching, thumbSize, selectedIds, focusIndex,
  onItemClick, onItemOpen, onItemContextMenu, onColsChange,
}: PhotoGridProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<FixedSizeGrid>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // 测量容器宽高；ResizeObserver 比 window.resize 更稳健（侧栏开合也能感知）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // 挂载时先同步量一次：窗口在后台时 ResizeObserver 回调可能迟迟不来
    const r = el.getBoundingClientRect()
    setSize({ w: Math.floor(r.width), h: Math.floor(r.height) })
    const ro = new ResizeObserver(([entry]) => {
      const cr = entry.contentRect
      setSize({ w: Math.floor(cr.width), h: Math.floor(cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = useMemo(() => Math.max(2, Math.round(size.w / thumbSize)), [size.w, thumbSize])
  // 列宽必须是整数否则 react-window 会出现亚像素抖动
  const cellSize = useMemo(() => (size.w > 0 ? Math.floor(size.w / cols) : 0), [size.w, cols])
  const rowCount = Math.ceil(results.length / cols)

  useEffect(() => { onColsChange(cols) }, [cols, onColsChange])

  useEffect(() => {
    if (focusIndex < 0 || !gridRef.current) return
    gridRef.current.scrollToItem({ rowIndex: Math.floor(focusIndex / cols), align: 'smart' })
  }, [focusIndex, cols])

  // 单元渲染：从 grid 坐标反算线性 index
  const Cell = useCallback(
    ({ columnIndex, rowIndex, style }: GridChildComponentProps) => {
      const idx = rowIndex * cols + columnIndex
      if (idx >= results.length) return null
      const result = results[idx]
      return (
        <div style={{ ...style, padding: GAP / 2 }}>
          <MediaCard
            result={result}
            index={idx}
            selected={selectedIds.has(result.photo.id)}
            rank={isSearching ? idx + 1 : undefined}
            onClick={onItemClick}
            onDoubleClick={onItemOpen}
            onContextMenu={onItemContextMenu}
          />
        </div>
      )
    },
    [results, cols, selectedIds, isSearching, onItemClick, onItemOpen, onItemContextMenu]
  )

  return (
    <div ref={containerRef} className="h-full overflow-hidden" style={{ padding: GAP / 2 }}>
      {size.w > 0 && size.h > 0 && (
        <FixedSizeGrid
          ref={gridRef}
          // key 让 cols 变化时强制重新挂载，避免内部缓存把错位单元留在原位
          key={`${cols}-${cellSize}`}
          columnCount={cols}
          columnWidth={cellSize}
          rowCount={rowCount}
          rowHeight={cellSize}
          width={size.w}
          height={size.h}
          overscanRowCount={2}
        >
          {Cell}
        </FixedSizeGrid>
      )}
    </div>
  )
}
