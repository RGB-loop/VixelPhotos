import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
import type { SearchResult } from '../../../shared/types'
import { MediaCard, type GridDensity } from './media/MediaCard'

/** 卡片间距（px）：每格四周各留一半。沉浸式更紧，让画面连成一片 */
const GAP = { immersive: 2, info: 6 } as const

interface PhotoGridProps {
  results: SearchResult[]
  isSearching?: boolean
  density: GridDensity
  /** 目标缩略图边长（px），由状态栏滑块控制；实际列宽按容器宽度取整均分 */
  thumbSize: number
  selectedIds: Set<number>
  /** 键盘焦点所在 index；变化时滚动到可见 */
  focusIndex: number
  /** 新搜索 / 换来源时变化：滚回顶部 */
  scrollResetKey?: number
  onItemClick: (index: number, e: React.MouseEvent) => void
  onItemOpen: (index: number) => void
  onItemContextMenu: (index: number, e: React.MouseEvent) => void
  /** 上报列数：方向键 ↑ ↓ 按行移动要用 */
  onColsChange: (cols: number) => void
  /** 点在卡片之外的空白处：取消选择 */
  onBackgroundClick: () => void
}

export function PhotoGrid({
  results, isSearching, density, thumbSize, selectedIds, focusIndex, scrollResetKey,
  onItemClick, onItemOpen, onItemContextMenu, onColsChange, onBackgroundClick,
}: PhotoGridProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<FixedSizeGrid>(null)
  const gap = GAP[density]
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

  // 宽度变化（检查器开合、侧栏拖动、窗口缩放）会改列宽 / 列数，网格按 key 重新挂载。
  // 重挂载默认回到顶部，所以先算好新位置：以焦点项（不可见时用首个可见项）为锚，
  // 让它在视口里的纵向偏移保持不变，点选后卡片不会"跳走"。
  const scrollTop = useRef(0)
  const prevLayout = useRef({ cols, cellSize })
  const focusRef = useRef(focusIndex)
  focusRef.current = focusIndex
  const layoutKey = `${cols}-${cellSize}`
  const initialScrollTop = useMemo(() => {
    const prev = prevLayout.current
    prevLayout.current = { cols, cellSize }
    if (prev.cellSize <= 0 || cellSize <= 0) return scrollTop.current
    const st = scrollTop.current
    const fi = focusRef.current
    const focusTop = fi >= 0 ? Math.floor(fi / prev.cols) * prev.cellSize : -1
    const focusVisible = fi >= 0 && focusTop + prev.cellSize > st && focusTop < st + size.h
    const anchor = focusVisible ? fi : Math.floor(st / prev.cellSize) * prev.cols
    const offset = Math.floor(anchor / prev.cols) * prev.cellSize - st
    const next = Math.max(0, Math.floor(anchor / cols) * cellSize - offset)
    scrollTop.current = next
    return next
    // 只在布局变化时重算；其余输入都从 ref 读
  }, [layoutKey])

  useEffect(() => { onColsChange(cols) }, [cols, onColsChange])

  // 新搜索：滚回顶部（挂载时也执行一次，无害）
  useEffect(() => {
    scrollTop.current = 0
    gridRef.current?.scrollTo({ scrollLeft: 0, scrollTop: 0 })
  }, [scrollResetKey])

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
        <div style={{ ...style, padding: gap / 2 }}>
          <MediaCard
            result={result}
            index={idx}
            selected={selectedIds.has(result.photo.id)}
            rank={isSearching ? idx + 1 : undefined}
            density={density}
            onClick={onItemClick}
            onDoubleClick={onItemOpen}
            onContextMenu={onItemContextMenu}
          />
        </div>
      )
    },
    [results, cols, selectedIds, isSearching, density, gap, onItemClick, onItemOpen, onItemContextMenu]
  )

  return (
    <div
      ref={containerRef}
      className="h-full overflow-hidden"
      style={{ padding: gap / 2 }}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('.photo-card')) onBackgroundClick() }}
    >
      {size.w > 0 && size.h > 0 && (
        <FixedSizeGrid
          ref={gridRef}
          // key 让 cols 变化时强制重新挂载，避免内部缓存把错位单元留在原位
          key={layoutKey}
          initialScrollTop={initialScrollTop}
          onScroll={({ scrollTop: t }) => { scrollTop.current = t }}
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
