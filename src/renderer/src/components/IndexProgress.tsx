import { useState, useEffect } from 'react'
import type { IndexProgress as IndexProgressType } from '../../../shared/types'

interface IndexProgressProps {
  progress: IndexProgressType | null
}

export function IndexProgress({ progress }: IndexProgressProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  // 有任务时自动展开
  useEffect(() => {
    if (progress && progress.stage !== 'idle' && progress.total > 0) {
      setIsExpanded(true)
    }
  }, [progress?.stage, progress?.total])

  const isProcessing = progress && progress.stage !== 'idle'
  const percentage = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0

  const stageText: Record<IndexProgressType['stage'], string> = {
    scanning: '扫描文件',
    embedding: '生成索引',
    captioning: '生成描述',
    idle: '空闲',
  }

  const stageIcon: Record<IndexProgressType['stage'], string> = {
    scanning: '🔍',
    embedding: '🧠',
    captioning: '💬',
    idle: '✓',
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      {/* 简洁状态栏 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
      >
        <div className="flex items-center gap-3">
          {isProcessing ? (
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-primary-500 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {stageIcon[progress!.stage]} {stageText[progress!.stage]}
                {progress?.currentFile && (
                  <span className="text-gray-500 dark:text-gray-400 ml-1">
                    - {progress.currentFile}
                  </span>
                )}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                已索引 {progress?.done || 0} 张照片
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {isProcessing && (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {progress?.done || 0} / {progress?.total || 0}
            </span>
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

      {/* 展开的详情 */}
      {isExpanded && (
        <div className="px-4 pb-3 space-y-3">
          {/* 进度条 */}
          {progress && progress.total > 0 && (
            <div className="space-y-1">
              <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ease-out ${
                    isProcessing ? 'bg-primary-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${percentage}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{percentage}% 完成</span>
                <span>剩余 {(progress.total || 0) - (progress.done || 0)} 张</span>
              </div>
            </div>
          )}

          {/* 阶段说明 */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className={`flex items-center gap-1 ${
              progress?.stage === 'embedding' ? 'text-primary-600 dark:text-primary-400 font-medium' : 'text-gray-500 dark:text-gray-400'
            }`}>
              <span>🧠</span>
              <span>图像索引</span>
            </div>
            <div className={`flex items-center gap-1 ${
              progress?.stage === 'captioning' ? 'text-primary-600 dark:text-primary-400 font-medium' : 'text-gray-500 dark:text-gray-400'
            }`}>
              <span>💬</span>
              <span>AI 描述</span>
            </div>
            <div className={`flex items-center gap-1 ${
              progress?.stage === 'idle' && progress.done > 0 ? 'text-green-600 dark:text-green-400 font-medium' : 'text-gray-500 dark:text-gray-400'
            }`}>
              <span>✓</span>
              <span>搜索就绪</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
