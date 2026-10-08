import { useEffect, useState } from 'react'
import type { IndexProgress } from '../../../../shared/types'

export const THUMB_MIN = 120
export const THUMB_MAX = 320

interface StatusBarProps {
  progress: IndexProgress | null
  /** 左侧"N 项"及悬停提示的构成明细 */
  itemCount: number
  breakdown: string
  selectedCount?: number
  onOpenActivity: () => void
  /** 仅网格视图显示缩略图大小滑块 */
  thumbSize?: number
  onThumbSize?: (size: number) => void
  /** 网格信息密度（G） */
  density?: 'immersive' | 'info'
  onToggleDensity?: () => void
}

/** 当前活动的一句话描述 + 进度（0–1，未知为 null） */
function describeActivity(p: IndexProgress | null): { text: string; detail?: string; ratio: number | null } | null {
  if (!p) return null
  const { totalPhotos: total, thumbnailedPhotos: thumbs, indexedPhotos: indexed } = p
  const ocr = p.ocrPhotos || 0
  if (p.stage === 'indexing') {
    if (thumbs < total) return { text: `生成缩略图 ${thumbs}/${total}`, detail: p.currentFile, ratio: total ? thumbs / total : null }
    if (indexed < thumbs) return { text: `生成索引 ${indexed}/${thumbs}`, detail: p.currentFile, ratio: thumbs ? indexed / thumbs : null }
    const cur = p.current
    if (cur && cur.taskType === 'extract_frames' && cur.segTotal > 0) {
      return {
        text: `处理${cur.kind === 'audio' ? '音频' : '视频'}片段 ${cur.segDone}/${cur.segTotal}`,
        detail: cur.name,
        ratio: cur.segDone / cur.segTotal,
      }
    }
    return { text: '处理音视频…', ratio: null }
  }
  if (p.stage === 'ocr') return { text: `识别图内文字 ${ocr}/${indexed}`, detail: p.currentFile, ratio: indexed ? ocr / indexed : null }
  if (p.stage === 'detecting_faces') return { text: '检测人脸…', ratio: null }
  return null
}

export function StatusBar({ progress, itemCount, breakdown, selectedCount = 0, onOpenActivity, thumbSize, onThumbSize, density, onToggleDensity }: StatusBarProps): JSX.Element {
  // 首个 progress 事件到来前先问一次主进程（暂停状态会跨重启保留）
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    window.api.getIndexPaused().then(setPaused).catch(() => {})
  }, [])
  useEffect(() => {
    if (progress?.paused !== undefined) setPaused(progress.paused)
  }, [progress?.paused])

  const togglePause = (): void => {
    window.api.setIndexPaused(!paused).then(setPaused).catch(() => {})
  }

  const activity = describeActivity(progress)
  const errorCount = progress?.queue?.error ?? 0

  return (
    <footer className="h-[26px] flex-shrink-0 flex items-center gap-3 px-3 bg-bar border-t border-line text-caption text-ink-3 select-none">
      <span className="tabular-nums flex-shrink-0" title={breakdown || undefined}>
        {itemCount.toLocaleString()} 项
        {selectedCount > 0 && <span className="text-ink-2"> · 已选 {selectedCount.toLocaleString()}</span>}
      </span>

      {/* 活动区：点开抽屉 */}
      <button
        onClick={onOpenActivity}
        title="查看活动 (⌥⌘A)"
        className="min-w-0 flex-1 h-full flex items-center gap-2 px-2 -mx-2 hover:bg-fill transition-colors duration-fast"
      >
        {paused ? (
          <span className="text-warn/80">索引已暂停</span>
        ) : activity ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse flex-shrink-0" />
            <span className="text-ink-2 tabular-nums flex-shrink-0">{activity.text}</span>
            {activity.detail && <span className="text-ink-4 truncate">{activity.detail}</span>}
            {activity.ratio !== null && (
              <span className="ml-auto w-20 h-[3px] bg-fill-active rounded-full overflow-hidden flex-shrink-0">
                <span
                  className="block h-full bg-accent rounded-full transition-[width] duration-view"
                  style={{ width: `${Math.round(activity.ratio * 100)}%` }}
                />
              </span>
            )}
          </>
        ) : (
          <span className="text-ink-4">{itemCount > 0 ? '索引已是最新' : '添加文件夹开始使用'}</span>
        )}
      </button>

      {errorCount > 0 && (
        <button
          onClick={onOpenActivity}
          className="flex-shrink-0 px-1.5 rounded bg-bad/10 text-bad/80 hover:bg-bad/20 tabular-nums transition-colors duration-fast"
        >
          {errorCount} 失败
        </button>
      )}

      {(activity || paused) && (
        <button
          onClick={togglePause}
          className="flex-shrink-0 px-1.5 rounded text-ink-2 hover:text-ink hover:bg-fill-hover transition-colors duration-fast"
        >
          {paused ? '继续' : '暂停'}
        </button>
      )}

      {density && onToggleDensity && (
        <button
          onClick={onToggleDensity}
          title={`信息密度：${density === 'info' ? '信息式' : '沉浸式'} (G)`}
          aria-pressed={density === 'info'}
          data-density={density}
          className={`flex-shrink-0 w-5 h-[18px] rounded flex items-center justify-center transition-colors duration-fast ${
            density === 'info' ? 'text-accent bg-accent/15' : 'text-ink-3 hover:text-ink hover:bg-fill-hover'
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
            {density === 'info' ? (
              <>
                <rect x="0.5" y="0.5" width="4.5" height="4.5" rx="1" /><rect x="7" y="0.5" width="4.5" height="4.5" rx="1" />
                <rect x="0.5" y="7" width="4.5" height="4.5" rx="1" /><rect x="7" y="7" width="4.5" height="4.5" rx="1" />
                <rect x="1.5" y="3.5" width="2.5" height="0.8" fill="var(--canvas)" /><rect x="8" y="3.5" width="2.5" height="0.8" fill="var(--canvas)" />
                <rect x="1.5" y="10" width="2.5" height="0.8" fill="var(--canvas)" /><rect x="8" y="10" width="2.5" height="0.8" fill="var(--canvas)" />
              </>
            ) : (
              <>
                <rect x="0" y="0" width="5.6" height="5.6" rx="0.8" /><rect x="6.4" y="0" width="5.6" height="5.6" rx="0.8" />
                <rect x="0" y="6.4" width="5.6" height="5.6" rx="0.8" /><rect x="6.4" y="6.4" width="5.6" height="5.6" rx="0.8" />
              </>
            )}
          </svg>
        </button>
      )}

      {thumbSize !== undefined && onThumbSize && (
        <label className="flex-shrink-0 flex items-center gap-1.5" title="缩略图大小 (⌘+ / ⌘−)">
          <span className="w-2 h-2 rounded-[2px] border border-ink-3" />
          <input
            type="range"
            min={THUMB_MIN}
            max={THUMB_MAX}
            step={10}
            value={thumbSize}
            onChange={(e) => onThumbSize(Number(e.target.value))}
            className="thumb-slider w-20"
          />
          <span className="w-3 h-3 rounded-[2px] border border-ink-3" />
        </label>
      )}
    </footer>
  )
}
