import { useEffect, useState } from 'react'
import type { MediaDetail, PhotoDetail, PhotoLocation, SearchResult } from '../../../../shared/types'
import { formatDuration, formatFileSize, mediaKindOf } from '../../lib/format'
import { thumbUrl } from '../../lib/mediaUrl'
import { Icon } from '../shell/icons'

const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' } as const

interface InspectorProps {
  result: SearchResult
  /** 点相似内容 */
  onSelect: (result: SearchResult) => void
  /** 停靠在主窗口时在顶部显示缩略图；详情页里主区已有大图，不需要 */
  showPreview?: boolean
  /** 详情页里有关闭按钮 */
  onClose?: () => void
  /** 播放器读到的真实分辨率（库里没记录时） */
  resolution?: { w: number; h: number } | null
}

/**
 * 检查器：单个项目的元数据、片段信息、文件位置和相似内容。
 * 主窗口右侧停靠面板和全屏详情页的侧栏共用这一个组件。
 * 媒体的 photo 行是代表图（首帧 / 封面 / 波形），文件大小、路径要用 MediaDetail 里源文件的。
 */
export function Inspector({ result, onSelect, showPreview, onClose, resolution: resolutionOverride }: InspectorProps): JSX.Element {
  const { photo, segment } = result
  const kind = mediaKindOf(photo)
  const isMedia = kind !== 'image' && photo.videoId != null
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  const [media, setMedia] = useState<MediaDetail | null>(null)
  const [locations, setLocations] = useState<PhotoLocation[]>([])
  const [similar, setSimilar] = useState<SearchResult[]>([])
  const [isEditingCaption, setIsEditingCaption] = useState(false)
  const [editCaption, setEditCaption] = useState('')

  useEffect(() => {
    let cancelled = false
    setIsEditingCaption(false)
    // 清掉上一张的内容，避免新照片顶着旧元数据
    setDetail(null)
    setLocations([])
    setSimilar([])
    // 方向键连按时防抖 250ms：停在哪张才为哪张发详情 / 位置 / 相似检索
    const timer = setTimeout(() => {
      Promise.all([
        window.api.getPhotoDetail(photo.id),
        window.api.getPhotoLocations(photo.id),
        window.api.findSimilar(photo.id, 6),
      ]).then(([d, locs, sim]) => {
        if (cancelled) return
        setDetail(d)
        setLocations(locs)
        setSimilar(sim)
      })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [photo.id])

  useEffect(() => {
    setMedia(null)
    if (!isMedia || photo.videoId == null) return
    let cancelled = false
    window.api.getMediaDetail(photo.videoId).then((m) => { if (!cancelled) setMedia(m) })
    return () => { cancelled = true }
  }, [isMedia, photo.videoId])

  const resolution = resolutionOverride ?? (media?.width && media.height ? { w: media.width, h: media.height } : null)
  const sourcePath = isMedia ? media?.filePath : photo.filePath
  const dup = photo.duplicateCount && photo.duplicateCount > 1 ? photo.duplicateCount : 0
  // 音频代表图没有图片向量，embed_status 永远 pending，不能算"索引中"
  const indexState = kind === 'audio' || photo.embedStatus === 'done'
    ? { label: '已索引', cls: 'text-ink-2' }
    : photo.embedStatus === 'error'
      ? { label: '失败', cls: 'text-bad' }
      : { label: '索引中', cls: 'text-warn' }

  return (
    <div className="h-full flex flex-col min-h-0">
      {showPreview && (
        <div className="p-3 pb-0">
          <div className="relative aspect-[4/3] rounded-lg overflow-hidden bg-surface-2">
            <img src={thumbUrl(photo)} alt={photo.fileName} className="absolute inset-0 w-full h-full object-contain" />
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 px-4 pt-3">
        <h2 className="text-headline text-ink flex-1 break-all">{photo.fileName}</h2>
        {onClose && <CloseButton onClick={onClose} />}
      </div>

      <div className="flex-1 overflow-auto px-4 pt-3 pb-4 flex flex-col gap-4">
        {/* 描述 */}
        <Section
          title="描述"
          action={!isEditingCaption && (
            <button
              onClick={() => { setEditCaption(detail?.caption || ''); setIsEditingCaption(true) }}
              className="text-caption text-ink-3 hover:text-ink px-1 rounded hover:bg-fill-hover transition-colors duration-fast"
            >
              {detail?.caption ? '编辑' : '添加'}
            </button>
          )}
        >
          {isEditingCaption ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                value={editCaption}
                onChange={(e) => setEditCaption(e.target.value)}
                onKeyDown={(e) => {
                  // Esc 只取消编辑，不冒泡到 App 关掉详情 / 清空选择
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setIsEditingCaption(false)
                  }
                }}
                className="w-full bg-fill border border-line-strong rounded-md p-1.5 text-ink text-callout resize-none focus:outline-none focus:border-accent/50"
                rows={3}
                autoFocus
              />
              <div className="flex gap-1.5">
                <button
                  onClick={async () => {
                    await window.api.updateCaption(photo.id, editCaption)
                    setDetail((prev) => prev ? { ...prev, caption: editCaption } : prev)
                    setIsEditingCaption(false)
                  }}
                  className="h-6 px-2 text-caption bg-accent text-black/85 font-medium rounded-md hover:brightness-110"
                >
                  保存
                </button>
                <button
                  onClick={() => setIsEditingCaption(false)}
                  className="h-6 px-2 text-caption bg-fill text-ink-2 rounded-md hover:bg-fill-hover"
                >
                  取消
                </button>
              </div>
            </div>
          ) : detail?.caption ? (
            <p className="text-ink text-callout">{detail.caption}</p>
          ) : (
            <p className="text-ink-4 text-callout">暂无描述</p>
          )}
        </Section>

        {detail?.ocrText && detail.ocrText.trim().length > 0 && (
          <Section title="图内文字">
            <p className="text-ink text-callout whitespace-pre-line break-words">{detail.ocrText}</p>
          </Section>
        )}

        {isMedia && (
          <Section title="媒体">
            <dl className="flex flex-col gap-1.5 text-callout">
              <Row label="类型">{KIND_LABEL[kind]}</Row>
              <Row label="时长">{media?.durationMs ? formatDuration(media.durationMs) : '–'}</Row>
              {kind === 'video' && <Row label="分辨率">{resolution ? `${resolution.w} × ${resolution.h}` : '–'}</Row>}
              <Row label="已索引片段">
                {media ? `${media.segments.length}${media.durationMs ? ` / ${Math.max(1, Math.ceil(media.durationMs / 32000))}` : ''}` : '–'}
              </Row>
              {segment && (
                <Row label="命中"><span className="text-accent">{formatDuration(segment.startMs)} – {formatDuration(segment.endMs)}</span></Row>
              )}
            </dl>
          </Section>
        )}

        <Section title="文件">
          <dl className="flex flex-col gap-1.5 text-callout">
            {!isMedia && <Row label="尺寸">{detail?.width && detail?.height ? `${detail.width} × ${detail.height}` : '–'}</Row>}
            <Row label="大小">{isMedia ? (media ? formatFileSize(media.fileSize) : '–') : formatFileSize(photo.fileSize)}</Row>
            {detail?.takenAt && <Row label="拍摄">{formatDate(detail.takenAt)}</Row>}
            <Row label="索引"><span className={indexState.cls}>{indexState.label}</span></Row>
            {dup > 0 && <Row label="副本">{dup} 份</Row>}
          </dl>
        </Section>

        {!isMedia && detail?.exif && (detail.exif.make || detail.exif.model) && (
          <Section title="相机">
            <dl className="flex flex-col gap-1.5 text-callout">
              {detail.exif.make && <Row label="品牌">{detail.exif.make}</Row>}
              {detail.exif.model && <Row label="型号">{detail.exif.model}</Row>}
              {detail.exif.focalLength && <Row label="焦距">{detail.exif.focalLength} mm</Row>}
              {detail.exif.fNumber && <Row label="光圈">f/{detail.exif.fNumber}</Row>}
              {detail.exif.exposureTime && <Row label="快门">{detail.exif.exposureTime} s</Row>}
              {detail.exif.iso && <Row label="ISO">{detail.exif.iso}</Row>}
            </dl>
          </Section>
        )}

        <Section title={`位置${locations.length > 1 ? ` · ${locations.length}` : ''}`}>
          <div className="flex flex-col gap-1">
            {isMedia || locations.length === 0 ? (
              <p className="text-ink-3 text-caption break-all bg-fill px-2 py-1.5 rounded-md select-text">{sourcePath ?? '–'}</p>
            ) : locations.map((loc, i) => (
              <div key={i} className="bg-fill px-2 py-1.5 rounded-md">
                <p className="text-ink-3 text-caption break-all select-text">{loc.filePath}</p>
                <p className="text-ink-4 text-micro mt-0.5">{loc.folderName}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5 mt-2">
            <ActionButton icon="folder" onClick={() => sourcePath && window.api.showInFinder(sourcePath)}>在访达中显示</ActionButton>
            {isMedia && (
              <ActionButton icon="video" onClick={() => photo.videoId != null && window.api.openSourceVideo(photo.videoId)}>
                系统播放器
              </ActionButton>
            )}
          </div>
        </Section>

        {similar.length > 0 && (
          <Section title="相似内容">
            <div className="grid grid-cols-3 gap-1">
              {similar.map((r) => (
                <button
                  key={r.photo.id}
                  onClick={() => onSelect(r)}
                  title={r.photo.fileName}
                  className="aspect-square rounded overflow-hidden bg-surface-2 hover:ring-2 hover:ring-accent/60 transition-shadow duration-fast"
                >
                  <img src={thumbUrl(r.photo)} alt={r.photo.fileName} className="w-full h-full object-cover" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

/** 多选时检查器显示的汇总 */
export function SelectionSummary({ results, breakdown, onReveal, onCopyPaths, onClose }: {
  results: SearchResult[]
  breakdown: string
  onReveal: () => void
  onCopyPaths: () => void
  onClose?: () => void
}): JSX.Element {
  const preview = results.slice(0, 9)
  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div className="grid grid-cols-3 gap-1">
        {preview.map((r) => (
          <div key={r.photo.id} className="aspect-square rounded overflow-hidden bg-surface-2">
            <img src={thumbUrl(r.photo)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
          </div>
        ))}
      </div>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-headline text-ink">已选择 {results.length} 项</h2>
          <p className="text-callout text-ink-3 mt-0.5">{breakdown}</p>
        </div>
        {onClose && <CloseButton onClick={onClose} />}
      </div>
      <div className="flex gap-1.5">
        <ActionButton icon="folder" onClick={onReveal}>在访达中显示</ActionButton>
        <ActionButton icon="all" onClick={onCopyPaths}>拷贝路径</ActionButton>
      </div>
    </div>
  )
}

function CloseButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="w-6 h-6 rounded-md text-ink-3 hover:text-ink hover:bg-fill-hover transition-colors duration-fast flex-shrink-0 flex items-center justify-center"
      title="关闭 (Esc)"
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section>
      <div className="h-5 flex items-center justify-between mb-1">
        <h3 className="text-caption font-semibold text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  // 截断的长值悬停能看全：纯文本内容直接作 tooltip
  const title = typeof children === 'string' || typeof children === 'number' ? String(children) : undefined
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-3 flex-shrink-0">{label}</dt>
      <dd className="text-ink-2 tabular-nums text-right truncate" title={title}>{children}</dd>
    </div>
  )
}

function ActionButton({ icon, onClick, children }: { icon: Parameters<typeof Icon>[0]['name']; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex-1 h-7 px-2 rounded-md bg-fill-hover hover:bg-fill-active text-ink text-callout flex items-center justify-center gap-1.5 transition-colors duration-fast"
    >
      <Icon name={icon} className="w-3.5 h-3.5 text-ink-2" />
      {children}
    </button>
  )
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
