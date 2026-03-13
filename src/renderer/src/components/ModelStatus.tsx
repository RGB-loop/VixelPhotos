import { useState, useEffect, useCallback } from 'react'
import type { ModelStatus as ModelStatusType, DownloadProgress } from '../../../shared/types'

interface DownloadState {
  isDownloading: boolean
  currentFile: string
  progress: DownloadProgress | null
  error: string | null
}

export function ModelStatus(): JSX.Element {
  const [status, setStatus] = useState<ModelStatusType | null>(null)
  const [loading, setLoading] = useState(true)
  const [downloadState, setDownloadState] = useState<DownloadState>({
    isDownloading: false,
    currentFile: '',
    progress: null,
    error: null,
  })

  // 加载模型状态
  const loadStatus = useCallback(async () => {
    try {
      const result = await window.api.getModelStatus()
      setStatus(result)
    } catch (error) {
      console.error('Failed to get model status:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // 监听下载进度
  useEffect(() => {
    const unsubscribe = window.api.onDownloadProgress((progress) => {
      setDownloadState((prev) => ({
        ...prev,
        progress,
      }))
    })
    return unsubscribe
  }, [])

  // 下载 llama-server
  const handleDownloadLlamaServer = async (): Promise<void> => {
    setDownloadState({
      isDownloading: true,
      currentFile: 'llama-server',
      progress: null,
      error: null,
    })

    const result = await window.api.downloadLlamaServer()

    if (result.success) {
      setDownloadState((prev) => ({ ...prev, isDownloading: false }))
      await loadStatus()
      await initCaptionGeneratorIfReady()
    } else {
      setDownloadState((prev) => ({
        ...prev,
        isDownloading: false,
        error: result.error || 'Download failed',
      }))
    }
  }

  // 下载模型
  const handleDownloadModel = async (type: 'model' | 'mmproj'): Promise<void> => {
    const fileName = type === 'model' ? 'Qwen3VL-4B-Instruct-Q4_K_M.gguf' : 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'

    setDownloadState({
      isDownloading: true,
      currentFile: fileName,
      progress: null,
      error: null,
    })

    const result = await window.api.downloadModel(type)

    if (result.success) {
      setDownloadState((prev) => ({ ...prev, isDownloading: false }))
      await loadStatus()
      await initCaptionGeneratorIfReady()
    } else {
      setDownloadState((prev) => ({
        ...prev,
        isDownloading: false,
        error: result.error || 'Download failed',
      }))
    }
  }

  // 取消下载
  const handleCancelDownload = async (): Promise<void> => {
    await window.api.cancelDownload(downloadState.currentFile)
    setDownloadState({
      isDownloading: false,
      currentFile: '',
      progress: null,
      error: null,
    })
  }

  // 下载全部
  const handleDownloadAll = async (): Promise<void> => {
    if (!status) return

    // 按顺序下载
    if (!status.llamaServerExists) {
      await handleDownloadLlamaServer()
      // 重新加载状态
      await loadStatus()
    }

    const newStatus = await window.api.getModelStatus()

    if (!newStatus.modelExists) {
      await handleDownloadModel('model')
      await loadStatus()
    }

    const finalStatus = await window.api.getModelStatus()

    if (!finalStatus.mmprojExists) {
      await handleDownloadModel('mmproj')
      await loadStatus()
    }

    // 所有下载完成后，初始化 caption generator
    await initCaptionGeneratorIfReady()
  }

  // 初始化 caption generator
  const initCaptionGeneratorIfReady = async (): Promise<void> => {
    const currentStatus = await window.api.getModelStatus()
    if (currentStatus.modelExists && currentStatus.mmprojExists && currentStatus.llamaServerExists) {
      console.log('All models ready, initializing caption generator...')
      const result = await window.api.initCaptionGenerator()
      if (result.success && result.ready) {
        console.log('Caption generator initialized successfully')
        loadStatus()
      } else if (result.error) {
        console.error('Failed to initialize caption generator:', result.error)
        setDownloadState(prev => ({ ...prev, error: result.error }))
      }
    }
  }

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  // 格式化速度
  const formatSpeed = (bytesPerSecond: number): string => {
    return formatSize(bytesPerSecond) + '/s'
  }

  if (loading) {
    return (
      <div className="p-6 text-center text-gray-500">
        <svg className="w-6 h-6 mx-auto animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="mt-2 text-sm">检查模型状态...</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="p-6 text-center text-red-500">
        无法检查模型状态
      </div>
    )
  }

  const allReady = status.modelExists && status.mmprojExists && status.llamaServerExists
  const totalSize = 2500 + 454 + 50 // MB (model + mmproj + llama-server)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 mb-1">
          Qwen3-VL-4B 视觉语言模型
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          用于自动生成照片的 AI 描述，支持语义搜索
        </p>
      </div>

      {/* 下载进度 */}
      {downloadState.isDownloading && downloadState.progress && (
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
              正在下载: {downloadState.currentFile}
            </span>
            <button
              onClick={handleCancelDownload}
              className="text-sm text-red-600 hover:text-red-700"
            >
              取消
            </button>
          </div>
          <div className="h-2 bg-blue-200 dark:bg-blue-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${downloadState.progress.percent}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-xs text-blue-600 dark:text-blue-400">
            <span>
              {formatSize(downloadState.progress.downloaded)} / {formatSize(downloadState.progress.total)}
            </span>
            <span>{formatSpeed(downloadState.progress.speed)}</span>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {downloadState.error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">
            下载失败: {downloadState.error}
          </p>
        </div>
      )}

      {/* 状态列表 */}
      <div className="space-y-3">
        {/* llama-server */}
        <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
          <div className="flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${status.llamaServerExists ? 'bg-green-500' : 'bg-gray-300'}`} />
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">llama-server</p>
              <p className="text-xs text-gray-500">推理引擎 (~50MB)</p>
            </div>
          </div>
          {status.llamaServerExists ? (
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">已安装</span>
          ) : (
            <button
              onClick={handleDownloadLlamaServer}
              disabled={downloadState.isDownloading}
              className="px-3 py-1 text-xs bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white rounded transition-colors"
            >
              下载
            </button>
          )}
        </div>

        {/* Model */}
        <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
          <div className="flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${status.modelExists ? 'bg-green-500' : 'bg-gray-300'}`} />
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Qwen3VL-4B-Instruct-Q4_K_M.gguf</p>
              <p className="text-xs text-gray-500">视觉语言模型 (~2.5GB)</p>
            </div>
          </div>
          {status.modelExists ? (
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">已下载</span>
          ) : (
            <button
              onClick={() => handleDownloadModel('model')}
              disabled={downloadState.isDownloading}
              className="px-3 py-1 text-xs bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white rounded transition-colors"
            >
              下载
            </button>
          )}
        </div>

        {/* mmproj */}
        <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
          <div className="flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${status.mmprojExists ? 'bg-green-500' : 'bg-gray-300'}`} />
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf</p>
              <p className="text-xs text-gray-500">视觉编码器 (~454MB)</p>
            </div>
          </div>
          {status.mmprojExists ? (
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">已下载</span>
          ) : (
            <button
              onClick={() => handleDownloadModel('mmproj')}
              disabled={downloadState.isDownloading}
              className="px-3 py-1 text-xs bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white rounded transition-colors"
            >
              下载
            </button>
          )}
        </div>
      </div>

      {/* 一键下载全部 */}
      {!allReady && (
        <button
          onClick={handleDownloadAll}
          disabled={downloadState.isDownloading}
          className="w-full py-2.5 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          下载全部 (~{(totalSize / 1024).toFixed(1)}GB)
        </button>
      )}

      {/* 全部下载完成但服务未启动 */}
      {allReady && !status.serverReady && (
        <button
          onClick={initCaptionGeneratorIfReady}
          disabled={downloadState.isDownloading}
          className="w-full py-2.5 px-4 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          启动 AI 服务
        </button>
      )}

      {/* 全部就绪 */}
      {allReady && status.serverReady && (
        <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm font-medium text-green-800 dark:text-green-200">
              AI 模型已就绪
            </span>
          </div>
          <p className="mt-1 text-xs text-green-600 dark:text-green-400">
            新照片将自动生成 AI 描述，支持语义搜索
          </p>
        </div>
      )}

      {/* 模型路径 */}
      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">模型存储位置</p>
        <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded block break-all text-gray-600 dark:text-gray-300">
          {status.modelsDir}
        </code>
      </div>
    </div>
  )
}
