import { useState, useEffect, useCallback } from 'react'
import type { ModelStatus as ModelStatusType, EmbeddingQuantizationConfig, BackupStatus } from '../../../shared/types'

type Quant = 'q4' | 'q8'
const QUANT_FIELDS: Array<{ key: 'textQuantization' | 'visionQuantization' | 'audioQuantization'; label: string }> = [
  { key: 'textQuantization', label: '文本' },
  { key: 'visionQuantization', label: '图像/视频' },
  { key: 'audioQuantization', label: '音频' },
]

/**
 * 模型状态面板
 *
 * 唯一 embedding 通道：本地 EmbeddingGemma 2（文本/图像/音频/视频，768D）
 * 高级：调整各编码器的量化档位（q4 更小更快，q8 更准）
 */
export function ModelStatus(): JSX.Element {
  const [status, setStatus] = useState<ModelStatusType | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [quantConfig, setQuantConfig] = useState<EmbeddingQuantizationConfig>({})
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<string | null>(null)
  const [ocrScanState, setOcrScanState] = useState<{ scanning: boolean; message: string | null }>({
    scanning: false,
    message: null,
  })
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const result = await window.api.getModelStatus()
      setStatus(result)

      const qc = await window.api.getEmbeddingConfig()
      setQuantConfig(qc)

      const bs = await window.api.getBackupStatus()
      setBackupStatus(bs)
    } catch (error) {
      console.error('Failed to get model status:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const triggerBackup = async (): Promise<void> => {
    setBackupBusy(true)
    setBackupMessage(null)
    try {
      const r = await window.api.triggerBackup()
      if (r.success) {
        const mb = r.sizeBytes ? (r.sizeBytes / 1024 / 1024).toFixed(1) : '?'
        setBackupMessage(`已生成备份（${mb} MB）`)
      } else {
        setBackupMessage(`失败: ${r.error}`)
      }
      const bs = await window.api.getBackupStatus()
      setBackupStatus(bs)
    } catch (e) {
      setBackupMessage(`失败: ${String(e)}`)
    } finally {
      setBackupBusy(false)
    }
  }

  const saveQuantization = async (patch: EmbeddingQuantizationConfig): Promise<void> => {
    setSaving(true)
    setSaveResult(null)
    try {
      const r = await window.api.setEmbeddingConfig(patch)
      setSaveResult(r.success ? '已切换量化档位' + (r.ready ? '（就绪）' : '') : `失败: ${r.error}`)
      await loadStatus()
    } finally {
      setSaving(false)
    }
  }

  const startOcrScan = async (): Promise<void> => {
    setOcrScanState({ scanning: true, message: null })
    try {
      const r = await window.api.startOcrScan()
      if (r.error) {
        setOcrScanState({ scanning: false, message: `失败: ${r.error}` })
      } else {
        setOcrScanState({
          scanning: false,
          message: r.queued && r.queued > 0
            ? `已加入 ${r.queued} 张照片到 OCR 队列`
            : '没有需要 OCR 的照片',
        })
      }
    } catch (e) {
      setOcrScanState({ scanning: false, message: `失败: ${String(e)}` })
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

  const localReady = status.localModelExists && status.embeddingReady
  const localMissing = !status.localModelExists

  return (
    <div className="p-5 space-y-5">
      <div>
        <h3 className="text-xs font-semibold text-white/80 mb-0.5">语义搜索模型</h3>
        <p className="text-[11px] text-white/30">本地 EmbeddingGemma 2 — 文本/图像/音频/视频统一检索、零网络</p>
      </div>

      {/* 主状态 */}
      <div className={`p-3 rounded-lg ${localReady ? 'bg-green-500/10' : localMissing ? 'bg-amber-500/10' : 'bg-white/5'}`}>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${localReady ? 'bg-green-500' : localMissing ? 'bg-amber-500' : 'bg-white/15'}`} />
          <div className="flex-1">
            {localReady && <p className="text-[11px] text-green-400/80">EmbeddingGemma 2 本地模型已就绪</p>}
            {localMissing && (
              <>
                <p className="text-[11px] text-amber-400/80">模型文件缺失</p>
                <p className="text-[10px] text-white/30 mt-0.5">
                  开发环境：执行 <code className="bg-white/5 px-1 rounded">node scripts/download-models.mjs</code>
                </p>
              </>
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

      {/* OCR */}
      <div className="pt-4 border-t border-white/5">
        <h3 className="text-xs font-semibold text-white/80 mb-0.5">图内文字搜索 (OCR)</h3>
        <p className="text-[11px] text-white/30 mb-2">
          扫描相册里的图片文字（截图、票据、海报等），扫完后可直接搜文字。
        </p>
        <button
          onClick={startOcrScan}
          disabled={ocrScanState.scanning}
          className="w-full py-1.5 px-3 bg-white/5 hover:bg-white/10 disabled:opacity-30 text-white/60 text-xs rounded-md"
        >
          {ocrScanState.scanning ? '排队中...' : '开始扫描图内文字'}
        </button>
        {ocrScanState.message && (
          <p className={`text-[11px] mt-1.5 ${ocrScanState.message.startsWith('失败') ? 'text-red-400' : 'text-green-400'}`}>
            {ocrScanState.message}
          </p>
        )}
      </div>

      {/* 数据库备份 */}
      <div className="pt-4 border-t border-white/5">
        <h3 className="text-xs font-semibold text-white/80 mb-0.5">数据库备份</h3>
        <p className="text-[11px] text-white/30 mb-2">
          每 24 小时自动备份一次 library.db（保留最近 3 份），可在此手动触发。
        </p>
        {backupStatus && (
          <div className="text-[10px] text-white/40 mb-2 space-y-0.5">
            <div>
              上次备份：{backupStatus.lastBackupAt
                ? new Date(backupStatus.lastBackupAt).toLocaleString('zh-CN')
                : '从未'}
            </div>
            <div>
              当前已保留：{backupStatus.currentCount} / {backupStatus.keepCount}
            </div>
          </div>
        )}
        <button
          onClick={triggerBackup}
          disabled={backupBusy || backupStatus?.inProgress}
          className="w-full py-1.5 px-3 bg-white/5 hover:bg-white/10 disabled:opacity-30 text-white/60 text-xs rounded-md"
        >
          {backupBusy ? '备份中...' : '立即备份'}
        </button>
        {backupMessage && (
          <p className={`text-[11px] mt-1.5 ${backupMessage.startsWith('失败') ? 'text-red-400' : 'text-green-400'}`}>
            {backupMessage}
          </p>
        )}
      </div>

      {/* 高级：量化档位 */}
      <div className="pt-4 border-t border-white/5">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-[11px] text-white/40 hover:text-white/60 transition-colors"
        >
          {showAdvanced ? '▾' : '▸'} 高级：量化档位
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-2.5">
            <p className="text-[10px] text-white/25">
              q4 更小更快，q8 精度更高。切换后模型会在下次搜索 / 索引时重新加载。
            </p>

            {QUANT_FIELDS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-[11px] text-white/50">{label}</span>
                <div className="flex gap-1">
                  {(['q4', 'q8'] as Quant[]).map((q) => (
                    <button
                      key={q}
                      onClick={() => saveQuantization({ [key]: q })}
                      disabled={saving || quantConfig[key] === q}
                      className={`py-1 px-2.5 text-[11px] rounded-md disabled:cursor-default ${
                        quantConfig[key] === q
                          ? 'bg-accent/20 text-accent'
                          : 'bg-white/5 hover:bg-white/10 text-white/50 disabled:opacity-30'
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {saveResult && (
              <p className={`text-[11px] ${saveResult.startsWith('失败') ? 'text-red-400' : 'text-green-400'}`}>
                {saveResult}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
