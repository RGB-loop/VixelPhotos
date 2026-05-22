import type { IndexProgress as IndexProgressType } from '../../../shared/types'

interface IndexProgressProps {
  progress: IndexProgressType | null
}

export function IndexProgress({ progress }: IndexProgressProps): JSX.Element {
  const totalPhotos = progress?.totalPhotos || 0
  const thumbnailedPhotos = progress?.thumbnailedPhotos || 0
  const indexedPhotos = progress?.indexedPhotos || 0
  const ocrPhotos = progress?.ocrPhotos || 0

  const isIndexing = progress?.stage === 'indexing'
  const isOcring = progress?.stage === 'ocr'
  const isFacing = progress?.stage === 'detecting_faces'
  const isWorking = isIndexing || isOcring || isFacing

  const pendingThumbnails = totalPhotos - thumbnailedPhotos
  const pendingEmbeddings = thumbnailedPhotos - indexedPhotos

  let statusText = ''
  let progressPercent = 0

  if (pendingThumbnails > 0 && isIndexing) {
    statusText = `生成缩略图 ${thumbnailedPhotos}/${totalPhotos}`
    progressPercent = totalPhotos > 0 ? Math.round((thumbnailedPhotos / totalPhotos) * 100) : 0
  } else if (pendingEmbeddings > 0 && isIndexing) {
    statusText = `生成索引 ${indexedPhotos}/${thumbnailedPhotos}`
    progressPercent = thumbnailedPhotos > 0 ? Math.round((indexedPhotos / thumbnailedPhotos) * 100) : 0
  } else if (isOcring) {
    statusText = `识别图内文字 ${ocrPhotos}/${indexedPhotos}`
    progressPercent = indexedPhotos > 0 ? Math.round((ocrPhotos / indexedPhotos) * 100) : 0
  } else if (isFacing) {
    statusText = '检测人脸…'
    progressPercent = 0
  }

  return (
    <div className="h-7 flex items-center px-4 bg-surface-1 border-t border-white/5 text-[11px] text-white/30">
      {isWorking && statusText ? (
        <div className="flex items-center gap-2 w-full">
          <svg className="w-3 h-3 text-accent animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span>{statusText}</span>
          {progress?.currentFile && (
            <span className="text-white/15 truncate">{progress.currentFile}</span>
          )}
          <div className="ml-auto w-16 h-1 bg-white/5 rounded-full overflow-hidden flex-shrink-0">
            <div
              className="h-full bg-accent/60 rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      ) : totalPhotos > 0 ? (
        <div className="flex items-center gap-1.5">
          <span>{totalPhotos} 张照片</span>
          {indexedPhotos < totalPhotos && (
            <span className="text-white/15">· {indexedPhotos} 已索引</span>
          )}
          {ocrPhotos > 0 && (
            <span className="text-white/15">· {ocrPhotos} 已识字</span>
          )}
        </div>
      ) : (
        <span>添加照片文件夹开始使用</span>
      )}
    </div>
  )
}
