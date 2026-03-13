import { useEffect, useState, useCallback } from 'react'
import type { Photo, PhotoDetail as PhotoDetailType } from '../../../shared/types'

interface PhotoDetailProps {
  photo: Photo
  onClose: () => void
}

export function PhotoDetail({ photo, onClose }: PhotoDetailProps): JSX.Element {
  const [detail, setDetail] = useState<PhotoDetailType | null>(null)
  const [imageUrl, setImageUrl] = useState<string>('')

  useEffect(() => {
    const loadDetail = async (): Promise<void> => {
      const data = await window.api.getPhotoDetail(photo.id)
      setDetail(data)
      // 使用 IPC 获取原图数据
      const imageData = await window.api.getFullImageData(photo.id)
      if (imageData) {
        setImageUrl(imageData)
      }
    }
    loadDetail()
  }, [photo])

  const handleShowInFinder = useCallback(async () => {
    await window.api.showInFinder(photo.filePath)
  }, [photo.filePath])

  // 阻止滚动
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  // 点击背景关闭
  const handleBackdropClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 flex"
      onClick={handleBackdropClick}
    >
      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
      >
        <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* 图片预览区域 */}
      <div className="flex-1 flex items-center justify-center p-8">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={photo.fileName}
            className="max-w-full max-h-full object-contain"
          />
        )}
      </div>

      {/* 信息侧边栏 */}
      <div className="w-80 bg-gray-900 border-l border-gray-700 p-6 overflow-auto">
        <h2 className="text-lg font-semibold text-white mb-4 truncate">{photo.fileName}</h2>

        {/* Caption */}
        {detail?.caption && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-400 mb-2">AI 描述</h3>
            <p className="text-gray-200 text-sm leading-relaxed">{detail.caption}</p>
          </div>
        )}

        {/* 文件信息 */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-400 mb-2">文件信息</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">尺寸</dt>
              <dd className="text-gray-200">
                {detail?.width && detail?.height ? `${detail.width} x ${detail.height}` : '-'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">大小</dt>
              <dd className="text-gray-200">{formatFileSize(photo.fileSize)}</dd>
            </div>
            {detail?.takenAt && (
              <div className="flex justify-between">
                <dt className="text-gray-500">拍摄时间</dt>
                <dd className="text-gray-200">{formatDate(detail.takenAt)}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* EXIF 信息 */}
        {detail?.exif && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-400 mb-2">相机信息</h3>
            <dl className="space-y-2 text-sm">
              {detail.exif.make && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">品牌</dt>
                  <dd className="text-gray-200">{detail.exif.make}</dd>
                </div>
              )}
              {detail.exif.model && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">型号</dt>
                  <dd className="text-gray-200">{detail.exif.model}</dd>
                </div>
              )}
              {detail.exif.focalLength && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">焦距</dt>
                  <dd className="text-gray-200">{detail.exif.focalLength}mm</dd>
                </div>
              )}
              {detail.exif.fNumber && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">光圈</dt>
                  <dd className="text-gray-200">f/{detail.exif.fNumber}</dd>
                </div>
              )}
              {detail.exif.exposureTime && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">快门</dt>
                  <dd className="text-gray-200">{detail.exif.exposureTime}s</dd>
                </div>
              )}
              {detail.exif.iso && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">ISO</dt>
                  <dd className="text-gray-200">{detail.exif.iso}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* 文件路径 */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-400 mb-2">文件路径</h3>
          <p className="text-gray-300 text-xs break-all bg-gray-800 p-2 rounded">
            {photo.filePath}
          </p>
        </div>

        {/* 操作按钮 */}
        <button
          onClick={handleShowInFinder}
          className="w-full py-2 px-4 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          在访达中显示
        </button>
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
