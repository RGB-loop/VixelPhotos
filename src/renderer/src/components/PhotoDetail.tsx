import { useEffect, useState, useCallback } from 'react'
import type { Photo, PhotoDetail as PhotoDetailType, PhotoLocation, SearchResult } from '../../../shared/types'

interface PhotoDetailProps {
  photo: Photo
  onSelect: (photo: Photo) => void
  onClose: () => void
}

export function PhotoDetail({ photo, onSelect, onClose }: PhotoDetailProps): JSX.Element {
  const [detail, setDetail] = useState<PhotoDetailType | null>(null)
  const [imageUrl, setImageUrl] = useState<string>('')
  const [locations, setLocations] = useState<PhotoLocation[]>([])
  const [isEditingCaption, setIsEditingCaption] = useState(false)
  const [editCaption, setEditCaption] = useState('')
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [similarPhotos, setSimilarPhotos] = useState<SearchResult[]>([])
  const [similarThumbnails, setSimilarThumbnails] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    const loadDetail = async (): Promise<void> => {
      const [data, imageData, locs, similar] = await Promise.all([
        window.api.getPhotoDetail(photo.id),
        window.api.getFullImageData(photo.id),
        window.api.getPhotoLocations(photo.id),
        window.api.findSimilar(photo.id, 6),
      ])
      setDetail(data)
      if (imageData) setImageUrl(imageData)
      setLocations(locs)
      setSimilarPhotos(similar)

      // 加载相似照片的缩略图
      const thumbs = new Map<number, string>()
      await Promise.all(
        similar.map(async (r) => {
          const thumb = await window.api.getThumbnailData(r.photo.id)
          if (thumb) thumbs.set(r.photo.id, thumb)
        })
      )
      setSimilarThumbnails(thumbs)
    }
    loadDetail()
  }, [photo])

  const handleShowInFinder = useCallback(async () => {
    await window.api.showInFinder(photo.filePath)
  }, [photo.filePath])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

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
      <div className="flex-1 flex items-center justify-center p-8">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={photo.fileName}
            className="max-w-full max-h-full object-contain animate-fade-in"
          />
        )}
      </div>

      {/* 信息侧边栏 */}
      <div className="w-72 bg-surface-1/80 glass border-l border-white/5 p-5 overflow-auto animate-slide-in">
        <div className="flex items-start gap-2 mb-4">
          <h2 className="text-sm font-semibold text-white flex-1 break-all leading-5">{photo.fileName}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <svg className="w-4 h-4 text-white/40 hover:text-white/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

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
              <button
                onClick={async () => {
                  setIsRegenerating(true)
                  try {
                    const result = await window.api.regenerateCaption(photo.id)
                    if (result.success && result.caption) {
                      setDetail((prev) => prev ? { ...prev, caption: result.caption } : prev)
                      setIsEditingCaption(false)
                    }
                  } finally {
                    setIsRegenerating(false)
                  }
                }}
                disabled={isRegenerating}
                className="p-0.5 rounded hover:bg-white/10 text-white/20 hover:text-white/50 disabled:opacity-30"
                title="重新生成"
              >
                <svg className={`w-3 h-3 ${isRegenerating ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
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

        {/* 文件信息 */}
        <div className="mb-5">
          <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1.5">文件信息</h3>
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <dt className="text-white/30">尺寸</dt>
              <dd className="text-white/60">
                {detail?.width && detail?.height ? `${detail.width} x ${detail.height}` : '-'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-white/30">大小</dt>
              <dd className="text-white/60">{formatFileSize(photo.fileSize)}</dd>
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
        {detail?.exif && (
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
            {locations.length > 0 ? locations.map((loc, i) => (
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
            <h3 className="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-2">相似照片</h3>
            <div className="grid grid-cols-3 gap-1">
              {similarPhotos.map((r) => (
                <button
                  key={r.photo.id}
                  onClick={() => onSelect(r.photo)}
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
      </div>
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
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
