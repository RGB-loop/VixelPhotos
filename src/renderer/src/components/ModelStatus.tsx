import { useState, useEffect, useCallback } from 'react'
import type { ModelStatus as ModelStatusType, DownloadProgress, ModelDownloadType, EmbeddingApiConfig, CaptionLanguage } from '../../../shared/types'

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

  const [embeddingConfig, setEmbeddingConfig] = useState<EmbeddingApiConfig>({
    endpoint: '',
    apiKey: '',
    model: '',
  })
  const [embeddingConfigSaving, setEmbeddingConfigSaving] = useState(false)
  const [embeddingTestResult, setEmbeddingTestResult] = useState<string | null>(null)
  const [captionLang, setCaptionLang] = useState<CaptionLanguage>('en')

  const loadStatus = useCallback(async () => {
    try {
      const result = await window.api.getModelStatus()
      setStatus(result)

      const config = await window.api.getEmbeddingConfig()
      if (config) {
        setEmbeddingConfig(config)
      }

      const captionConfig = await window.api.getCaptionConfig()
      setCaptionLang(captionConfig.language)
    } catch (error) {
      console.error('Failed to get model status:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const unsubscribe = window.api.onDownloadProgress((progress) => {
      setDownloadState((prev) => ({
        ...prev,
        progress,
      }))
    })
    return unsubscribe
  }, [])

  const handleDownloadLlamaServer = async (): Promise<void> => {
    setDownloadState({ isDownloading: true, currentFile: 'llama-server', progress: null, error: null })
    const result = await window.api.downloadLlamaServer()
    if (result.success) {
      setDownloadState((prev) => ({ ...prev, isDownloading: false }))
      await loadStatus()
    } else {
      setDownloadState((prev) => ({ ...prev, isDownloading: false, error: result.error || 'Download failed' }))
    }
  }

  const handleDownloadModel = async (type: ModelDownloadType, fileName: string): Promise<void> => {
    setDownloadState({ isDownloading: true, currentFile: fileName, progress: null, error: null })
    const result = await window.api.downloadModel(type)
    if (result.success) {
      setDownloadState((prev) => ({ ...prev, isDownloading: false }))
      await loadStatus()
    } else {
      setDownloadState((prev) => ({ ...prev, isDownloading: false, error: result.error || 'Download failed' }))
    }
  }

  const handleCancelDownload = async (): Promise<void> => {
    await window.api.cancelDownload(downloadState.currentFile)
    setDownloadState({ isDownloading: false, currentFile: '', progress: null, error: null })
  }

  const handleDownloadAll = async (): Promise<void> => {
    if (!status) return

    if (!status.llamaServerExists) {
      await handleDownloadLlamaServer()
      await loadStatus()
    }

    let newStatus = await window.api.getModelStatus()
    if (!newStatus.captionModelExists) {
      await handleDownloadModel('caption', 'Qwen3.5-4B-Q4_K_M.gguf')
      await loadStatus()
    }

    newStatus = await window.api.getModelStatus()
    if (!newStatus.captionMmprojExists) {
      await handleDownloadModel('captionMmproj', 'mmproj-Qwen3.5-4B-F16.gguf')
      await loadStatus()
    }

    await initAIService()
  }

  const initAIService = async (): Promise<void> => {
    const currentStatus = await window.api.getModelStatus()
    if (currentStatus.captionReady && currentStatus.llamaServerExists) {
      const result = await window.api.initCaptionGenerator()
      if (result.success && result.ready) {
        loadStatus()
      } else if (result.error) {
        setDownloadState((prev) => ({ ...prev, error: result.error }))
      }
    }
  }

  const handleSaveEmbeddingConfig = async (): Promise<void> => {
    if (!embeddingConfig.endpoint) {
      setEmbeddingTestResult('请输入 API Endpoint')
      return
    }
    setEmbeddingConfigSaving(true)
    setEmbeddingTestResult(null)
    try {
      const result = await window.api.setEmbeddingConfig(embeddingConfig)
      if (result.success) {
        setEmbeddingTestResult('配置已保存' + (result.ready ? '，API 已就绪' : ''))
        await loadStatus()
      } else {
        setEmbeddingTestResult('保存失败: ' + (result.error || '未知错误'))
      }
    } catch (error) {
      setEmbeddingTestResult('保存失败: ' + String(error))
    } finally {
      setEmbeddingConfigSaving(false)
    }
  }

  const handleTestEmbeddingApi = async (): Promise<void> => {
    setEmbeddingTestResult('测试中...')
    try {
      const result = await window.api.testEmbeddingApi()
      if (result.success) {
        setEmbeddingTestResult(`API 正常，向量维度: ${result.dimension}`)
      } else {
        setEmbeddingTestResult('测试失败: ' + (result.error || '未知错误'))
      }
    } catch (error) {
      setEmbeddingTestResult('测试失败: ' + String(error))
    }
  }

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  const formatSpeed = (bytesPerSecond: number): string => {
    return formatSize(bytesPerSecond) + '/s'
  }

  if (loading) {
    return (
      <div className="p-5 text-center">
        <svg className="w-5 h-5 mx-auto animate-spin text-white/20" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="mt-2 text-xs text-white/30">检查模型状态...</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="p-5 text-center text-red-400 text-xs">
        无法检查模型状态
      </div>
    )
  }

  const captionReady = status.captionReady && status.llamaServerExists
  const totalSize = 2740 + 672 + 50

  return (
    <div className="p-5 space-y-5">
      {/* Caption 模型 */}
      <div>
        <h3 className="text-xs font-semibold text-white/80 mb-0.5">Qwen3.5-4B 视觉语言模型</h3>
        <p className="text-[11px] text-white/30">用于自动生成照片描述</p>
      </div>

      {/* 下载进度 */}
      {downloadState.isDownloading && downloadState.progress && (
        <div className="p-3 bg-accent/10 rounded-lg">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-accent">{downloadState.currentFile}</span>
            <button onClick={handleCancelDownload} className="text-[10px] text-red-400 hover:text-red-300">取消</button>
          </div>
          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-accent/60 transition-all duration-300" style={{ width: `${downloadState.progress.percent}%` }} />
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-accent/60">
            <span>{formatSize(downloadState.progress.downloaded)} / {formatSize(downloadState.progress.total)}</span>
            <span>{formatSpeed(downloadState.progress.speed)}</span>
          </div>
        </div>
      )}

      {downloadState.error && (
        <div className="p-2.5 bg-red-500/10 rounded-lg">
          <p className="text-[11px] text-red-400">下载失败: {downloadState.error}</p>
        </div>
      )}

      {/* 状态列表 */}
      <div className="space-y-1.5">
        {[
          { exists: status.llamaServerExists, name: 'llama-server', desc: '推理引擎 (~50MB)', onDownload: handleDownloadLlamaServer },
          { exists: status.captionModelExists, name: 'Qwen3.5-4B-Q4_K_M.gguf', desc: '视觉模型 (~2.7GB)', onDownload: () => handleDownloadModel('caption', 'Qwen3.5-4B-Q4_K_M.gguf') },
          { exists: status.captionMmprojExists, name: 'mmproj-F16.gguf', desc: '视觉编码器 (~672MB)', onDownload: () => handleDownloadModel('captionMmproj', 'mmproj-F16.gguf') },
        ].map((item) => (
          <div key={item.name} className="flex items-center justify-between p-2.5 bg-white/5 rounded-lg">
            <div className="flex items-center gap-2.5">
              <span className={`w-2 h-2 rounded-full ${item.exists ? 'bg-green-500' : 'bg-white/15'}`} />
              <div>
                <p className="text-xs text-white/70">{item.name}</p>
                <p className="text-[10px] text-white/25">{item.desc}</p>
              </div>
            </div>
            {item.exists ? (
              <span className="text-[10px] text-green-400/60">已安装</span>
            ) : (
              <button
                onClick={item.onDownload}
                disabled={downloadState.isDownloading}
                className="px-2.5 py-1 text-[10px] bg-white/8 hover:bg-white/12 disabled:opacity-30 text-white/60 rounded transition-colors"
              >
                下载
              </button>
            )}
          </div>
        ))}
      </div>

      {!captionReady && (
        <button
          onClick={handleDownloadAll}
          disabled={downloadState.isDownloading}
          className="w-full py-2 px-3 bg-accent/20 hover:bg-accent/30 disabled:opacity-30 text-accent text-xs rounded-md transition-colors"
        >
          下载全部 (~{(totalSize / 1024).toFixed(1)}GB)
        </button>
      )}

      {captionReady && !status.serverReady && (
        <button
          onClick={initAIService}
          disabled={downloadState.isDownloading}
          className="w-full py-2 px-3 bg-green-500/20 hover:bg-green-500/30 disabled:opacity-30 text-green-300 text-xs rounded-md transition-colors"
        >
          启动 AI 服务
        </button>
      )}

      {captionReady && status.serverReady && (
        <div className="p-2.5 bg-green-500/10 rounded-lg flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-[11px] text-green-400/80">Caption 模型已就绪</span>
        </div>
      )}

      {/* Caption 语言 */}
      <div className="pt-4 border-t border-white/5">
        <h3 className="text-xs font-semibold text-white/80 mb-0.5">描述语言</h3>
        <p className="text-[11px] text-white/30 mb-2">新照片的 AI 描述将使用选定语言生成</p>
        <div className="flex gap-2">
          {([['en', 'English'], ['zh', '中文']] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={async () => {
                setCaptionLang(val)
                await window.api.setCaptionConfig({ language: val })
              }}
              className={`flex-1 py-1.5 text-xs rounded-md transition-colors ${
                captionLang === val
                  ? 'bg-accent/20 text-accent'
                  : 'bg-white/5 text-white/40 hover:bg-white/10'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Embedding API */}
      <div className="pt-4 border-t border-white/5">
        <h3 className="text-xs font-semibold text-white/80 mb-0.5">Embedding API</h3>
        <p className="text-[11px] text-white/30 mb-3">配置外部 Embedding API 以支持语义搜索</p>

        <div className="space-y-2.5">
          <div>
            <label className="block text-[10px] text-white/30 mb-1">API Endpoint *</label>
            <input
              type="text"
              value={embeddingConfig.endpoint}
              onChange={(e) => setEmbeddingConfig({ ...embeddingConfig, endpoint: e.target.value })}
              placeholder="http://localhost:8080/embeddings"
              className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-md text-white/80 placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
            />
          </div>

          <div>
            <label className="block text-[10px] text-white/30 mb-1">API Key（可选）</label>
            <input
              type="password"
              value={embeddingConfig.apiKey || ''}
              onChange={(e) => setEmbeddingConfig({ ...embeddingConfig, apiKey: e.target.value })}
              placeholder="sk-..."
              className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-md text-white/80 placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
            />
          </div>

          <div>
            <label className="block text-[10px] text-white/30 mb-1">Model（可选）</label>
            <input
              type="text"
              value={embeddingConfig.model || ''}
              onChange={(e) => setEmbeddingConfig({ ...embeddingConfig, model: e.target.value })}
              placeholder="text-embedding-3-small"
              className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-md text-white/80 placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
            />
          </div>

          {embeddingTestResult && (
            <p className={`text-[11px] ${embeddingTestResult.includes('失败') || embeddingTestResult.includes('请输入') ? 'text-red-400' : 'text-green-400'}`}>
              {embeddingTestResult}
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSaveEmbeddingConfig}
              disabled={embeddingConfigSaving || !embeddingConfig.endpoint}
              className="flex-1 py-1.5 px-3 bg-accent/20 hover:bg-accent/30 disabled:opacity-30 text-accent text-xs rounded-md transition-colors"
            >
              {embeddingConfigSaving ? '保存中...' : '保存配置'}
            </button>
            <button
              onClick={handleTestEmbeddingApi}
              disabled={!status.embeddingApiConfigured}
              className="py-1.5 px-3 bg-white/5 hover:bg-white/10 disabled:opacity-30 text-white/50 text-xs rounded-md transition-colors"
            >
              测试
            </button>
          </div>

          {status.embeddingApiConfigured && (
            <div className={`p-2.5 rounded-lg flex items-center gap-2 ${status.embeddingReady ? 'bg-green-500/10' : 'bg-amber-500/10'}`}>
              <span className={`w-2 h-2 rounded-full ${status.embeddingReady ? 'bg-green-500' : 'bg-amber-500'}`} />
              <div>
                <span className={`text-[11px] ${status.embeddingReady ? 'text-green-400/80' : 'text-amber-400/80'}`}>
                  {status.embeddingReady ? 'Embedding API 已就绪' : 'API 已配置，等待初始化'}
                </span>
                {status.embeddingApiEndpoint && (
                  <p className="text-[10px] text-white/20 truncate mt-0.5">{status.embeddingApiEndpoint}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 模型路径 */}
      <div className="pt-4 border-t border-white/5">
        <p className="text-[10px] text-white/20 mb-1">模型存储位置</p>
        <code className="text-[10px] bg-white/5 px-2 py-1 rounded block break-all text-white/30">
          {status.modelsDir}
        </code>
      </div>
    </div>
  )
}
