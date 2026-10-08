import { useEffect, useState } from 'react'
import type { IndexProgress as IndexProgressType } from '../../../shared/types'

interface IndexProgressProps {
  progress: IndexProgressType | null
}

export function IndexProgress({ progress }: IndexProgressProps): JSX.Element {
  const totalPhotos = progress?.totalPhotos || 0
  const thumbnailedPhotos = progress?.thumbnailedPhotos || 0
  const indexedPhotos = progress?.indexedPhotos || 0
  const ocrPhotos = progress?.ocrPhotos || 0

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

  const isIndexing = progress?.stage === 'indexing'
  const isOcring = progress?.stage === 'ocr'
  const isFacing = progress?.stage === 'detecting_faces'
  const isWorking = !paused && (isIndexing || isOcring || isFacing)

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
   } else if (isIndexing) {
    // 照片都处理完了，剩下的是视频片段编码
    statusText = '处理视频…'
    progressPercent = 0
  }

  const pauseButton = (isWorking || paused) && (
    <button
      onClick={togglePause}
      className="ml-3 flex-shrink-0 px-2 py-0.5 rounded text-white/50 hover:text-white/80 hover:bg-white/5 transition-colors"
    >
      {paused ? '继续' : '暂停'}
    </button>
  )

  return (
    <div className="h-7 flex items-center px-4 bg-surface-1 border-t border-white/5 text-[11px] text-white/30">
      {paused ? (
        <div className="flex items-center gap-1.5 w-full">
          <span className="text-amber-400/70">索引已暂停</span>
          {totalPhotos > 0 && <span className="text-white/15">· {indexedPhotos}/{totalPhotos} 已索引</span>}
          <div className="ml-auto">{pauseButton}</div>
        </div>
      ) : isWorking && statusText ? (
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
          {pauseButton}
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
