import { useCallback, useEffect, useRef, useState } from 'react'
import type { IndexProgress, MediaKind, TaskOverview, TaskRow, TaskType } from '../../../../shared/types'
import { formatSpan } from '../../lib/format'

interface TaskDrawerProps {
  open: boolean
  onClose: () => void
  progress: IndexProgress | null
}

const TASK_LABELS: Record<TaskType, string> = {
  thumbnail: '缩略图',
  embed: '图片向量',
  extract_frames: '音视频片段',
  ocr: '图内文字',
  face: '人脸',
}
const TASK_ORDER: TaskType[] = ['thumbnail', 'embed', 'extract_frames', 'ocr', 'face']

const KIND_LABELS: Record<MediaKind, string> = { image: '图片', video: '视频', audio: '音频' }

// ETA 用最近 N 个片段耗时的均值；单个片段受内容影响波动大（静态画面 vs 4K 运动）
const ETA_WINDOW = 8
const POLL_MS = 2000

/**
 * 底栏点开的任务抽屉：整体进度 + 当前任务 + 队列 + 失败列表。
 *
 * 常驻挂载（open=false 时不渲染 DOM），这样关着时也在收集片段耗时，打开就有 ETA。
 * 打开期间每 2s 轮询 getTaskOverview；当前任务走 progress 事件实时更新。
 */
export function TaskDrawer({ open, onClose, progress }: TaskDrawerProps): JSX.Element | null {
  const [overview, setOverview] = useState<TaskOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const segSamples = useRef<number[]>([])
  const lastSample = useRef<string>('')

  const current = progress?.current
  useEffect(() => {
    if (!current?.lastSegMs) return
    // 同一片段的 progress 会重复推送（缩略图任务穿插时），按 name+segDone 去重
    const key = `${current.name}#${current.segDone}`
    if (key === lastSample.current) return
    lastSample.current = key
    segSamples.current = [...segSamples.current.slice(-(ETA_WINDOW - 1)), current.lastSegMs]
  }, [current?.name, current?.segDone, current?.lastSegMs])

  const refresh = useCallback(async () => {
    try {
      setOverview(await window.api.getTaskOverview())
    } catch (err) {
      console.error('getTaskOverview failed:', err)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // 抢在 App 的 Esc（关详情 / 设置）之前处理
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const paused = progress?.paused ?? false
  const togglePause = (): void => {
    window.api.setIndexPaused(!paused).catch(() => {})
  }

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const media = overview?.media
  const photos = overview?.photos
  const segRemaining = media ? Math.max(0, media.segmentsExpected - media.segmentsDone) : 0
  const avgSegMs = segSamples.current.length > 0
    ? segSamples.current.reduce((a, b) => a + b, 0) / segSamples.current.length
    : 0
  const etaMs = avgSegMs * segRemaining

  const queueByType = TASK_ORDER
    .map((type) => {
      const c = overview?.counts[type] ?? {}
      return { type, active: (c.pending ?? 0) + (c.processing ?? 0), error: c.error ?? 0 }
    })
    .filter((q) => q.active > 0 || q.error > 0)
  const errors = overview?.errors ?? []
  const upcoming = (overview?.pending ?? []).filter((t) => t.status === 'pending')

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30 animate-fade-in" onClick={onClose} />
      <div
        className="fixed inset-x-0 bottom-0 z-40 h-[55vh] bg-raised border-t border-line-strong rounded-t-xl shadow-2xl flex flex-col animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label="活动"
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 px-5 h-11 border-b border-line flex-shrink-0">
          <h2 className="text-body font-medium text-ink">活动</h2>
          {paused ? (
            <span className="text-caption text-warn/70">已暂停</span>
          ) : progress?.stage !== 'idle' && progress?.stage ? (
            <span className="text-caption text-accent/70">运行中</span>
          ) : (
            <span className="text-caption text-ink-4">空闲</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={togglePause}
              className="px-2.5 py-1 rounded-md text-caption text-ink-2 hover:text-ink hover:bg-fill-hover transition-colors"
            >
              {paused ? '继续索引' : '暂停索引'}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-ink-3 hover:text-ink hover:bg-fill-hover transition-colors"
              title="关闭 (Esc)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* 整体进度 */}
          <section className="grid grid-cols-2 gap-4">
            <ProgressStat
              label="图片"
              done={photos?.indexed ?? 0}
              total={photos?.total ?? 0}
              detail={photos && photos.thumbnailed < photos.total ? `缩略图 ${photos.thumbnailed}/${photos.total}` : undefined}
            />
            <ProgressStat
              label="音视频片段"
              done={media?.segmentsDone ?? 0}
              total={media?.segmentsExpected ?? 0}
              detail={media
                ? [
                    media.video.total > 0 ? `视频 ${media.video.done}/${media.video.total}` : '',
                    media.audio.total > 0 ? `音频 ${media.audio.done}/${media.audio.total}` : '',
                    segRemaining > 0 && etaMs > 0 && !paused ? `剩余约 ${formatSpan(etaMs)}` : '',
                  ].filter(Boolean).join(' · ')
                : undefined}
            />
          </section>

          {/* 当前任务 */}
          <section>
            <SectionTitle>正在处理</SectionTitle>
            {current ? (
              <div className="bg-fill rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-2 text-callout">
                  <KindBadge kind={current.kind} />
                  <span className="text-ink truncate flex-1">{current.name}</span>
                  <span className="text-ink-3 flex-shrink-0">{TASK_LABELS[current.taskType]}</span>
                </div>
                {current.segTotal > 1 && (
                  <div className="mt-2 flex items-center gap-3">
                    <Bar ratio={current.segDone / current.segTotal} />
                    <span className="text-caption text-ink-3 tabular-nums flex-shrink-0">
                      片段 {current.segDone}/{current.segTotal}
                    </span>
                  </div>
                )}
                <div className="mt-1.5 text-micro text-ink-4 tabular-nums">
                  已用 {formatSpan(Date.now() - current.startedAt)}
                  {current.lastSegMs ? ` · 上一片段 ${(current.lastSegMs / 1000).toFixed(1)}s` : ''}
                </div>
              </div>
            ) : (
              <p className="text-callout text-ink-4">{paused ? '已暂停，点「继续索引」恢复' : '没有正在运行的任务'}</p>
            )}
          </section>

          {/* 队列 */}
          {queueByType.length > 0 && (
            <section>
              <SectionTitle>队列</SectionTitle>
              <div className="flex flex-wrap gap-2 mb-2">
                {queueByType.map((q) => (
                  <span key={q.type} className="px-2 py-1 rounded-md bg-fill text-caption text-ink-2">
                    {TASK_LABELS[q.type]} <span className="text-ink tabular-nums">{q.active}</span>
                    {q.error > 0 && <span className="text-bad/70"> · {q.error} 失败</span>}
                  </span>
                ))}
              </div>
              {upcoming.length > 0 && (
                <ul className="space-y-0.5">
                  {upcoming.map((t) => <TaskLine key={t.id} task={t} />)}
                </ul>
              )}
            </section>
          )}

          {/* 失败 */}
          {errors.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <SectionTitle className="mb-0">失败 {errors.length}</SectionTitle>
                <div className="ml-auto flex gap-1">
                  <button
                    disabled={busy}
                    onClick={() => runAction(() => window.api.retryFailedTasks())}
                    className="px-2 py-0.5 rounded text-caption text-accent/80 hover:bg-accent/10 disabled:opacity-40"
                  >
                    全部重试
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => runAction(() => window.api.clearFailedTasks())}
                    className="px-2 py-0.5 rounded text-caption text-ink-3 hover:text-ink hover:bg-fill disabled:opacity-40"
                  >
                    清除
                  </button>
                </div>
              </div>
              <ul className="space-y-1">
                {errors.map((t) => (
                  <li key={t.id} className="group bg-fill rounded-md px-3 py-2">
                    <div className="flex items-center gap-2 text-callout">
                      <KindBadge kind={t.kind} />
                      <span className="text-ink truncate flex-1">{t.name ?? '(已删除)'}</span>
                      <span className="text-micro text-ink-4 flex-shrink-0">
                        {TASK_LABELS[t.taskType]}{t.retryCount > 0 ? ` · 重试 ${t.retryCount} 次` : ''}
                      </span>
                      <button
                        disabled={busy}
                        onClick={() => runAction(() => window.api.retryFailedTasks([t.id]))}
                        className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded text-micro text-accent/80 hover:bg-accent/10 transition-opacity disabled:opacity-40"
                      >
                        重试
                      </button>
                    </div>
                    {t.errorMsg && (
                      <p className="mt-1 text-micro text-bad/60 break-all line-clamp-2">{t.errorMsg}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {overview && !current && queueByType.length === 0 && errors.length === 0 && (
            <p className="text-callout text-ink-4 text-center pt-4">全部完成 ✓</p>
          )}
        </div>
      </div>
    </>
  )
}

function SectionTitle({ children, className = 'mb-2' }: { children: React.ReactNode; className?: string }): JSX.Element {
  return <h3 className={`text-caption font-medium text-ink-3 uppercase tracking-wide ${className}`}>{children}</h3>
}

function Bar({ ratio }: { ratio: number }): JSX.Element {
  return (
    <div className="flex-1 h-1.5 bg-fill rounded-full overflow-hidden">
      <div
        className="h-full bg-accent/70 rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
      />
    </div>
  )
}

function ProgressStat({ label, done, total, detail }: { label: string; done: number; total: number; detail?: string }): JSX.Element {
  const ratio = total > 0 ? done / total : 0
  return (
    <div className="bg-fill rounded-lg px-3 py-2.5">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-callout text-ink-2">{label}</span>
        <span className="ml-auto text-caption text-ink-3 tabular-nums">
          {total > 0 ? `${done}/${total} · ${Math.floor(ratio * 100)}%` : '—'}
        </span>
      </div>
      <Bar ratio={ratio} />
      {detail && <p className="mt-1.5 text-micro text-ink-4 tabular-nums">{detail}</p>}
    </div>
  )
}

function KindBadge({ kind }: { kind: MediaKind }): JSX.Element {
  const color = kind === 'video' ? 'text-info/70 bg-info/10'
    : kind === 'audio' ? 'text-violet-300/70 bg-violet-400/10'
    : 'text-ink-3 bg-fill'
  return <span className={`px-1.5 py-px rounded text-micro flex-shrink-0 ${color}`}>{KIND_LABELS[kind]}</span>
}

function TaskLine({ task }: { task: TaskRow }): JSX.Element {
  return (
    <li className="flex items-center gap-2 text-caption px-1 py-0.5">
      <KindBadge kind={task.kind} />
      <span className="text-ink-2 truncate flex-1">{task.name ?? '(已删除)'}</span>
      <span className="text-ink-4 flex-shrink-0">{TASK_LABELS[task.taskType]}</span>
    </li>
  )
}
