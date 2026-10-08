import { useEffect, useState, useCallback, useMemo } from 'react'
import type { MediaDetail, PhotoDetail as PhotoDetailType, PhotoLocation, SearchResult } from '../../../shared/types'
import { MediaPlayer } from './media/MediaPlayer'
import { formatDuration, formatFileSize, mediaKindOf } from '../lib/format'

interface PhotoDetailProps {
  /** 带 segment 的搜索结果：音视频打开时跳到命中片段 */
  result: SearchResult
  /** 当前结果集，用于 ← → 键翻浏览 */
  siblings?: SearchResult[]
  onSelect: (result: SearchResult) => void
  onClose: () => void
}

const KIND_LABEL = { image: '照片', video: '视频', audio: '音频' } as const

/**
 * 详情页：图片显示原图；视频 / 音频主区换成 MediaPlayer（命中片段自动起播 + 片段条），
 * 侧栏"媒体信息"取代原来的"视频帧"。
 * 媒体的 photo 行是代表图（首帧 / 封面 / 波形），文件大小、路径要用 MediaDetail 里源文件的。
 */
export function PhotoDetail({ result, siblings, onSelect, onClose }: PhotoDetailProps): JSX.Element {
  const { photo, segment } = result
  const kind = mediaKindOf(photo)
  const isMedia = kind !== 'image' && photo.videoId != null
  const [media, setMedia] = useState<MediaDetail | null>(null)
  const [resolution, setResolution] = useState<{ w: number; h: number } | null>(null)
  const [detail, setDetail] = useState<PhotoDetailType | null>(null)
  const [imageUrl, setImageUrl] = useState<string>('')
  const [locations, setLocations] = useState<PhotoLocation[]>([])
  const [isEditingCaption, setIsEditingCaption] = useState(false)
  const [editCaption, setEditCaption] = useState('')
  const [similarPhotos, setSimilarPhotos] = useState<SearchResult[]>([])
  const [similarThumbnails, setSimilarThumbnails] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    const loadDetail = async (): Promise<void> => {
      // 原图和相似照片缩略图都走 vixel:// 协议，<img> 自己 fetch；
      // 这里只取元数据 / 位置 / 相似列表。
      const [data, locs, similar] = await Promise.all([
        window.api.getPhotoDetail(photo.id),
        window.api.getPhotoLocations(photo.id),
        window.api.findSimilar(photo.id, 6),
      ])
      setDetail(data)
      setImageUrl(`vixel://image/${photo.id}`)
      setLocations(locs)
      setSimilarPhotos(similar)
      // 相似缩略图也直接用 vixel:// 协议，无需预先 base64 fetch
      const thumbs = new Map<number, string>()
      for (const r of similar) {
        thumbs.set(r.photo.id, `vixel://thumb/${r.photo.id}`)
      }
      setSimilarThumbnails(thumbs)
    }
    loadDetail()
  }, [photo])

  useEffect(() => {
    setMedia(null)
    setResolution(null)
    if (!isMedia || photo.videoId == null) return
    let cancelled = false
    window.api.getMediaDetail(photo.videoId).then((m) => {
      if (cancelled) return
      setMedia(m)
      if (m?.width && m.height) setResolution({ w: m.width, h: m.height })
    })
    return () => { cancelled = true }
  }, [isMedia, photo.videoId])

  const sourcePath = isMedia ? media?.filePath : photo.filePath
  const handleShowInFinder = useCallback(async () => {
    if (sourcePath) await window.api.showInFinder(sourcePath)
  }, [sourcePath])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  // 当前照片在 siblings 中的位置，决定 ← → 是否可用
  const currentIndex = useMemo(() => {
    if (!siblings) return -1
    return siblings.findIndex((r) => r.photo.id === photo.id)
  }, [siblings, photo.id])
  const hasPrev = currentIndex > 0
  const hasNext = siblings != null && currentIndex >= 0 && currentIndex < siblings.length - 1

  // 键盘导航：← / → 在 siblings 中切换；忽略输入框中的按键
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      // 编辑 caption 时不抢键盘
      // 焦点在原生播放控件上时 ← → 是快进 / 快退，不翻页
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'VIDEO', 'AUDIO'].includes(target.tagName)) return
      if (e.key === 'ArrowLeft' && hasPrev && siblings) {
        e.preventDefault()
        onSelect(siblings[currentIndex - 1])
      } else if (e.key === 'ArrowRight' && hasNext && siblings) {
        e.preventDefault()
        onSelect(siblings[currentIndex + 1])
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [siblings, currentIndex, hasPrev, hasNext, onSelect])

  const handleBackdropClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/95 flex animate-fade-in modal-overlay"
      onClick={handleBackdropClick}
    >
      {/* 图片预览区域 */}
      <div className="flex-1 min-w-0 flex items-center justify-center p-8 relative">
        {isMedia ? (
          media ? (
            <MediaPlayer
              // key：切换到另一个媒体时重建播放器，重新跳到命中片段
              key={`${media.id}-${segment?.startMs ?? ''}`}
              media={media}
              posterPhotoId={photo.id}
              hit={segment}
              onResolution={(w, h) => setResolution({ w, h })}
            />
          ) : (
            <img src={`vixel://thumb/${photo.id}`} alt={photo.fileName} className="max-w-full max-h-full object-contain opacity-60" />
          )
        ) : imageUrl && (
          <img
            src={imageUrl}
            alt={photo.fileName}
            className="max-w-full max-h-full object-contain animate-fade-in"
          />
        )}

        {/* ← → 翻浏览按钮（仅当 siblings 提供且不在边缘时显示） */}
        {hasPrev && siblings && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(siblings[currentIndex - 1]) }}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm flex items-center justify-center transition-colors"
            title="上一个 (←)"
          >
            <svg className="w-5 h-5 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        {hasNext && siblings && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(siblings[currentIndex + 1]) }}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm flex items-center justify-center transition-colors"
            title="下一个 (→)"
          >
            <svg className="w-5 h-5 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* 位置指示 "3 / 50" */}
        {siblings && currentIndex >= 0 && (
          <div className="absolute top-4 left-4 px-2 py-1 rounded bg-black/40 backdrop-blur-sm text-white/70 text-[11px] tabular-nums pointer-events-none">
            {currentIndex + 1} / {siblings.length}
          </div>
        )}
      </div>

      {/* 信息侧边栏 */}
      <div className="w-72 bg-surface-1/80 glass border-l border-white/5 flex flex-col animate-slide-in">
        {/* 固定头部（不滚动） */}
        <div className="flex items-start gap-2 p-5 pb-0">
          <h2 className="text-sm font-semibold text-white flex-1 break-all leading-5">{photo.fileName}</h2>
          <button
            onClick={(e) => { e.stopPropagation(); onClose() }}
            className="w-7 h-7 rounded-md bg-white/10 hover:bg-white/25 active:bg-white/30 transition-colors flex-shrink-0 flex items-center justify-center cursor-pointer"
            title="关闭 (Esc)"
          >
            <svg className="w-4 h-4 text-white/60 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* 可滚动内容 */}
        <div className="flex-1 overflow-auto p-5 pt-4">

        {/* Caption */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider">描述</h3>
            <div className="flex items-center gap-1">
              {detail?.caption && !isEditingCaption && (
                <button
                  onClick={() => { setEditCaption(detail.caption || ''); setIsEditingCaption(true) }}
                  className="p-0.5 rounded hover:bg-white/10 text-white/20 hover:text-white/50"
                  title="编辑"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              )}
              {!detail?.caption && !isEditingCaption && (
                <button
                  onClick={() => { setEditCaption(''); setIsEditingCaption(true) }}
                  className="p-0.5 rounded hover:bg-white/10 text-white/20 hover:text-white/50"
                  title="添加描述"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {isEditingCaption ? (
            <div className="space-y-1.5">
              <textarea
                value={editCaption}
                onChange={(e) => setEditCaption(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded p-1.5 text-white/70 text-xs leading-relaxed resize-none focus:outline-none focus:border-white/20"
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
                  className="px-2 py-1 text-[10px] bg-accent/20 text-accent rounded hover:bg-accent/30"
                >
                  保存
                </button>
                <button
                  onClick={() => setIsEditingCaption(false)}
                  className="px-2 py-1 text-[10px] bg-white/5 text-white/40 rounded hover:bg-white/10"
                >
                  取消
                </button>
              </div>
            </div>
          ) : detail?.caption ? (
            <p className="text-white/70 text-xs leading-relaxed">{detail.caption}</p>
          ) : (
            <p className="text-white/20 text-xs italic">暂无描述</p>
          )}
        </div>

        {/* OCR 文本（PaddleOCR 扫出来的图内文字） */}
        {detail?.ocrText && detail.ocrText.trim().length > 0 && (
          <div className="mb-5">
            <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1.5">图内文字</h3>
            <p className="text-white/70 text-xs leading-relaxed whitespace-pre-line break-words">
              {detail.ocrText}
            </p>
          </div>
        )}

        {/* 媒体信息：类型 / 时长 / 分辨率 / 片段 / 命中区间 */}
        {isMedia && (
          <div className="mb-5">
            <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1.5">媒体信息</h3>
            <dl className="space-y-1.5 text-xs mb-2.5">
              <div className="flex justify-between">
                <dt className="text-white/30">类型</dt>
                <dd className="text-white/60">{KIND_LABEL[kind]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/30">时长</dt>
                <dd className="text-white/60 tabular-nums">
                  {media?.durationMs ? formatDuration(media.durationMs) : '-'}
                </dd>
              </div>
              {kind === 'video' && (
                <div className="flex justify-between">
                  <dt className="text-white/30">分辨率</dt>
                  <dd className="text-white/60 tabular-nums">{resolution ? `${resolution.w} x ${resolution.h}` : '-'}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-white/30">已索引片段</dt>
                <dd className="text-white/60 tabular-nums">
                  {media ? `${media.segments.length}${media.durationMs ? ` / ${Math.max(1, Math.ceil(media.durationMs / 32000))}` : ''}` : '-'}
                </dd>
              </div>
              {segment && (
                <div className="flex justify-between">
                  <dt className="text-white/30">命中</dt>
                  <dd className="text-accent tabular-nums">
                    {formatDuration(segment.startMs)} – {formatDuration(segment.endMs)}
                  </dd>
                </div>
              )}
            </dl>
            <button
              onClick={async () => {
                if (photo.videoId != null) await window.api.openSourceVideo(photo.videoId)
              }}
              className="w-full py-1.5 px-3 bg-accent/15 hover:bg-accent/25 text-accent text-xs rounded-md flex items-center justify-center gap-1.5 transition-colors"
              title="在系统默认播放器中打开"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              在系统播放器中打开
            </button>
          </div>
        )}

        {/* 文件信息 */}
        <div className="mb-5">
          <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1.5">文件信息</h3>
          <dl className="space-y-1.5 text-xs">
            {!isMedia && (
              <div className="flex justify-between">
                <dt className="text-white/30">尺寸</dt>
                <dd className="text-white/60">
                  {detail?.width && detail?.height ? `${detail.width} x ${detail.height}` : '-'}
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-white/30">大小</dt>
              <dd className="text-white/60">
                {isMedia ? (media ? formatFileSize(media.fileSize) : '-') : formatFileSize(photo.fileSize)}
              </dd>
            </div>
            {detail?.takenAt && (
              <div className="flex justify-between">
                <dt className="text-white/30">拍摄</dt>
                <dd className="text-white/60">{formatDate(detail.takenAt)}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* EXIF 信息 */}
        {!isMedia && detail?.exif && (
          <div className="mb-5">
            <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1.5">相机</h3>
            <dl className="space-y-1.5 text-xs">
              {detail.exif.make && (
                <div className="flex justify-between">
                  <dt className="text-white/30">品牌</dt>
                  <dd className="text-white/60">{detail.exif.make}</dd>
                </div>
              )}
              {detail.exif.model && (
                <div className="flex justify-between">
                  <dt className="text-white/30">型号</dt>
                  <dd className="text-white/60">{detail.exif.model}</dd>
                </div>
              )}
              {detail.exif.focalLength && (
                <div className="flex justify-between">
                  <dt className="text-white/30">焦距</dt>
                  <dd className="text-white/60">{detail.exif.focalLength}mm</dd>
                </div>
              )}
              {detail.exif.fNumber && (
                <div className="flex justify-between">
                  <dt className="text-white/30">光圈</dt>
                  <dd className="text-white/60">f/{detail.exif.fNumber}</dd>
                </div>
              )}
              {detail.exif.exposureTime && (
                <div className="flex justify-between">
                  <dt className="text-white/30">快门</dt>
                  <dd className="text-white/60">{detail.exif.exposureTime}s</dd>
                </div>
              )}
              {detail.exif.iso && (
                <div className="flex justify-between">
                  <dt className="text-white/30">ISO</dt>
                  <dd className="text-white/60">{detail.exif.iso}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* 文件位置 */}
        <div className="mb-5">
          <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1.5">
            位置{locations.length > 1 ? ` (${locations.length})` : ''}
          </h3>
          <div className="space-y-1.5">
            {isMedia ? (
              <p className="text-white/30 text-[10px] break-all bg-white/5 p-2 rounded">{media?.filePath ?? '-'}</p>
            ) : locations.length > 0 ? locations.map((loc, i) => (
              <div key={i} className="bg-white/5 p-2 rounded">
                <p className="text-white/30 text-[10px] break-all">{loc.filePath}</p>
                <p className="text-white/15 text-[9px] mt-0.5">{loc.folderName}</p>
              </div>
            )) : (
              <p className="text-white/30 text-[10px] break-all bg-white/5 p-2 rounded">
                {photo.filePath}
              </p>
            )}
          </div>
        </div>

        {/* 操作按钮 */}
        <button
          onClick={handleShowInFinder}
          className="w-full py-2 px-3 bg-white/8 hover:bg-white/12 text-white/70 text-xs rounded-md transition-colors flex items-center justify-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          在访达中显示
        </button>

        {/* 相似照片 */}
        {similarPhotos.length > 0 && (
          <div className="mt-5 pt-4 border-t border-white/5">
            <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-2">相似内容</h3>
            <div className="grid grid-cols-3 gap-1">
              {similarPhotos.map((r) => (
                <button
                  key={r.photo.id}
                  onClick={() => onSelect(r)}
                  className="aspect-square rounded overflow-hidden bg-surface-2 hover:ring-1 hover:ring-accent/50 transition-all"
                >
                  {similarThumbnails.get(r.photo.id) ? (
                    <img
                      src={similarThumbnails.get(r.photo.id)}
                      alt={r.photo.fileName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full image-placeholder" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        </div>{/* 可滚动内容结束 */}
      </div>{/* 侧边栏结束 */}
    </div>
  )
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
