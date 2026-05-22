import { useState, useEffect, useCallback } from 'react'
import type { ModelStatus as ModelStatusType, EmbeddingApiConfig } from '../../../shared/types'

/**
 * 模型状态面板（v0.2）
 *
 * 主路径：本地 SigLIP 2 ONNX（默认）
 * 高级：可切到外部 OpenAI 兼容多模态 Embedding API
 */
export function ModelStatus(): JSX.Element {
  const [status, setStatus] = useState<ModelStatusType | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [apiConfig, setApiConfig] = useState<EmbeddingApiConfig>({
    endpoint: '',
    apiKey: '',
    model: '',
  })
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const result = await window.api.getModelStatus()
      setStatus(result)

      const existing = await window.api.getEmbeddingConfig()
      if (existing) {
        setApiConfig(existing)
        setShowAdvanced(true)
      }
    } catch (error) {
      console.error('Failed to get model status:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const switchToLocal = async (): Promise<void> => {
    setSaving(true)
    setTestResult(null)
    try {
      const r = await window.api.setEmbeddingConfig(null)
      setTestResult(r.success ? '已切回本地模型' + (r.ready ? '（就绪）' : '') : `失败: ${r.error}`)
      await loadStatus()
    } finally {
      setSaving(false)
    }
  }

  const saveApiConfig = async (): Promise<void> => {
    if (!apiConfig.endpoint) {
      setTestResult('请输入 API Endpoint')
      return
    }
    setSaving(true)
    setTestResult(null)
    try {
      const r = await window.api.setEmbeddingConfig(apiConfig)
      setTestResult(r.success ? '已切到 API' + (r.ready ? '（就绪）' : '') : `失败: ${r.error}`)
      await loadStatus()
    } finally {
      setSaving(false)
    }
  }

  const testApi = async (): Promise<void> => {
    setTestResult('测试中...')
    try {
      const r = await window.api.testEmbeddingApi()
      setTestResult(r.success ? `API 正常，向量维度: ${r.dimension}` : `测试失败: ${r.error}`)
    } catch (error) {
      setTestResult(`测试失败: ${String(error)}`)
    }
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
      <div className="p-5 text-center text-red-400 text-xs">无法检查模型状态</div>
    )
  }

  const isLocal = status.providerType === 'onnx-local'
  const localReady = isLocal && status.localModelExists && status.embeddingReady
  const localMissing = isLocal && !status.localModelExists

  return (
    <div className="p-5 space-y-5">
      <div>
        <h3 className="text-xs font-semibold text-white/80 mb-0.5">语义搜索模型</h3>
        <p className="text-[11px] text-white/30">本地 SigLIP 2 base/16-256 — 多语言、零网络</p>
      </div>

      {/* 主状态 */}
      <div className={`p-3 rounded-lg ${localReady ? 'bg-green-500/10' : localMissing ? 'bg-amber-500/10' : 'bg-white/5'}`}>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${localReady ? 'bg-green-500' : localMissing ? 'bg-amber-500' : 'bg-white/15'}`} />
          <div className="flex-1">
            {localReady && <p className="text-[11px] text-green-400/80">SigLIP 2 本地模型已就绪</p>}
            {localMissing && (
              <>
                <p className="text-[11px] text-amber-400/80">模型文件缺失</p>
                <p className="text-[10px] text-white/30 mt-0.5">
                  开发环境：执行 <code className="bg-white/5 px-1 rounded">node scripts/download-models.mjs</code>
                </p>
              </>
            )}
            {!isLocal && (
              <p className="text-[11px] text-white/60">
                当前使用外部 API ({status.apiEndpoint || 'unset'})
              </p>
            )}
            {status.initError && (
              <p className="text-[10px] text-red-400/80 mt-1">{status.initError}</p>
            )}
          </div>
        </div>
      </div>

      <div className="text-[10px] text-white/30">
        <p>模型存储位置</p>
        <code className="text-[10px] bg-white/5 px-2 py-1 rounded block break-all text-white/30 mt-1">
          {status.modelsDir}
        </code>
      </div>

      {/* 高级：外部 API */}
      <div className="pt-4 border-t border-white/5">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-[11px] text-white/40 hover:text-white/60 transition-colors"
        >
          {showAdvanced ? '▾' : '▸'} 高级：外部 Embedding API
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-2.5">
            <p className="text-[10px] text-white/25">
              切到外部多模态 Embedding API（OpenAI 兼容 messages 格式）。本地模型不可用时的兜底方案。
            </p>

            <div>
              <label className="block text-[10px] text-white/30 mb-1">API Endpoint</label>
              <input
                type="text"
                value={apiConfig.endpoint}
                onChange={(e) => setApiConfig({ ...apiConfig, endpoint: e.target.value })}
                placeholder="http://localhost:8080/embeddings"
                className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-md text-white/80 placeholder-white/20 focus:outline-none focus:border-white/20"
              />
            </div>

            <div>
              <label className="block text-[10px] text-white/30 mb-1">API Key（可选）</label>
              <input
                type="password"
                value={apiConfig.apiKey || ''}
                onChange={(e) => setApiConfig({ ...apiConfig, apiKey: e.target.value })}
                placeholder="sk-..."
                className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-md text-white/80 placeholder-white/20 focus:outline-none focus:border-white/20"
              />
            </div>

            <div>
              <label className="block text-[10px] text-white/30 mb-1">Model（可选）</label>
              <input
                type="text"
                value={apiConfig.model || ''}
                onChange={(e) => setApiConfig({ ...apiConfig, model: e.target.value })}
                placeholder="qwen3-vl-embedding"
                className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/8 rounded-md text-white/80 placeholder-white/20 focus:outline-none focus:border-white/20"
              />
            </div>

            {testResult && (
              <p className={`text-[11px] ${testResult.includes('失败') || testResult.includes('请输入') ? 'text-red-400' : 'text-green-400'}`}>
                {testResult}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={saveApiConfig}
                disabled={saving || !apiConfig.endpoint}
                className="flex-1 py-1.5 px-3 bg-accent/20 hover:bg-accent/30 disabled:opacity-30 text-accent text-xs rounded-md"
              >
                {saving ? '保存中...' : '使用 API'}
              </button>
              <button
                onClick={testApi}
                disabled={!status.apiConfigured}
                className="py-1.5 px-3 bg-white/5 hover:bg-white/10 disabled:opacity-30 text-white/50 text-xs rounded-md"
              >
                测试
              </button>
              {!isLocal && (
                <button
                  onClick={switchToLocal}
                  disabled={saving}
                  className="py-1.5 px-3 bg-white/5 hover:bg-white/10 disabled:opacity-30 text-white/50 text-xs rounded-md"
                >
                  切回本地
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
