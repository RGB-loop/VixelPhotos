import { useState } from 'react'
import type { IndexProgress as IndexProgressType } from '../../../shared/types'

interface IndexProgressProps {
  progress: IndexProgressType | null
}

export function IndexProgress({ progress }: IndexProgressProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  // 计算状态
  const totalPhotos = progress?.totalPhotos || 0
  const indexedPhotos = progress?.indexedPhotos || 0
  const captionedPhotos = progress?.captionedPhotos || 0
  const aiModelReady = progress?.aiModelReady || false

  const isIndexing = progress?.stage === 'indexing'
  const isCaptioning = progress?.stage === 'captioning'
  const isWorking = isIndexing || isCaptioning

  // 计算进度百分比
  const indexProgress = totalPhotos > 0 ? Math.round((indexedPhotos / totalPhotos) * 100) : 0
  const captionProgress = totalPhotos > 0 ? Math.round((captionedPhotos / totalPhotos) * 100) : 0

  // 待处理数量
  const pendingIndex = totalPhotos - indexedPhotos
  const pendingCaption = indexedPhotos - captionedPhotos

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      {/* 主状态栏 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {isWorking ? (
            // 工作中状态
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-primary-500 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {isIndexing ? (
                  <>正在索引 <span className="font-medium">{indexedPhotos}/{totalPhotos}</span></>
                ) : (
                  <>生成 AI 描述 <span className="font-medium">{captionedPhotos}/{indexedPhotos}</span></>
                )}
              </span>
              {progress?.currentFile && (
                <span className="text-xs text-gray-400 truncate max-w-32">
                  {progress.currentFile}
                </span>
              )}
            </div>
          ) : totalPhotos > 0 ? (
            // 空闲状态，有照片
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {totalPhotos} 张照片
                {captionedPhotos > 0 && captionedPhotos < indexedPhotos && (
                  <span className="text-gray-400 dark:text-gray-500 ml-1">
                    · {captionedPhotos} 有 AI 描述
                  </span>
                )}
              </span>
            </div>
          ) : (
            // 没有照片
            <span className="text-sm text-gray-400 dark:text-gray-500">
              添加照片文件夹开始使用
            </span>
          )}
        </div>

        {/* 右侧：迷你进度或展开按钮 */}
        <div className="flex items-center gap-2">
          {isWorking && (
            <div className="w-20 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary-500 transition-all duration-300"
                style={{ width: `${isIndexing ? indexProgress : captionProgress}%` }}
              />
            </div>
          )}
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* 展开的详情面板 */}
      {isExpanded && (
        <div className="px-4 pb-3 space-y-3">
          {/* 索引进度 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                图像索引
              </span>
              <span className="text-gray-500">
                {indexedPhotos} / {totalPhotos}
                {pendingIndex > 0 && <span className="text-gray-400 ml-1">({pendingIndex} 待处理)</span>}
              </span>
            </div>
            <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${indexProgress}%` }}
              />
            </div>
          </div>

          {/* AI 描述进度 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
                <span className={`w-2 h-2 rounded-full ${aiModelReady ? 'bg-purple-500' : 'bg-gray-300'}`} />
                AI 描述
                {!aiModelReady && (
                  <span className="text-gray-400">(模型未启动)</span>
                )}
              </span>
              <span className="text-gray-500">
                {captionedPhotos} / {indexedPhotos}
                {pendingCaption > 0 && aiModelReady && (
                  <span className="text-gray-400 ml-1">({pendingCaption} 待生成)</span>
                )}
              </span>
            </div>
            <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${aiModelReady ? 'bg-purple-500' : 'bg-gray-300'}`}
                style={{ width: indexedPhotos > 0 ? `${(captionedPhotos / indexedPhotos) * 100}%` : '0%' }}
              />
            </div>
          </div>

          {/* 状态说明 */}
          {!aiModelReady && totalPhotos > 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              提示：在设置中启动 AI 模型后，可自动生成照片描述，支持语义搜索
            </p>
          )}
        </div>
      )}
    </div>
  )
}
