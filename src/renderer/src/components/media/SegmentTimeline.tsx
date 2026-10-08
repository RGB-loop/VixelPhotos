import { useState } from 'react'
import { formatDuration } from '../../lib/format'

interface Segment {
  startMs: number
  endMs: number
}

interface SegmentTimelineProps {
  durationMs: number
  /** 已编码入库的片段；缺口 = 编码失败 / 尚未索引 */
  segments: Segment[]
  /** 搜索命中的片段 */
  hit?: Segment
  currentMs: number
  onSeek: (ms: number) => void
}

/**
 * 32s 片段条：每个片段一格，命中片段 accent 高亮，播放位置画竖线。
 * 点击片段跳到片段开头 —— 片段是检索的语义单位，比精确到像素的位置更有用；
 * 精确拖动交给原生播放控件。
 */
export function SegmentTimeline({ durationMs, segments, hit, currentMs, onSeek }: SegmentTimelineProps): JSX.Element | null {
  const [hover, setHover] = useState<Segment | null>(null)
  if (durationMs <= 0) return null
  const pct = (ms: number): string => `${Math.min(100, Math.max(0, (ms / durationMs) * 100))}%`
  const isHit = (s: Segment): boolean => hit != null && s.startMs === hit.startMs

  return (
    <div className="w-full select-none">
      <div className="flex items-center justify-between text-[10px] text-white/35 mb-1 h-4 tabular-nums">
        <span>
          片段 {segments.length}
          {hit && <span className="text-accent/80"> · 命中 {formatDuration(hit.startMs)}–{formatDuration(hit.endMs)}</span>}
        </span>
        {hover && <span className="text-white/60">{formatDuration(hover.startMs)} – {formatDuration(hover.endMs)}</span>}
      </div>
      <div className="relative h-5 rounded bg-white/5 overflow-hidden" onMouseLeave={() => setHover(null)}>
        {segments.map((s) => (
          <button
            key={s.startMs}
            onClick={(e) => { e.stopPropagation(); onSeek(s.startMs) }}
            onMouseEnter={() => setHover(s)}
            className={`absolute top-0 bottom-0 border-r border-black/60 transition-colors ${
              isHit(s) ? 'bg-accent/70 hover:bg-accent' : 'bg-white/12 hover:bg-white/25'
            }`}
            style={{ left: pct(s.startMs), width: `calc(${pct(s.endMs - s.startMs)})` }}
            title={`${formatDuration(s.startMs)} – ${formatDuration(s.endMs)}`}
          />
        ))}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none shadow-[0_0_4px_rgba(255,255,255,0.8)]"
          style={{ left: pct(currentMs) }}
        />
      </div>
    </div>
  )
}
