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
            ? `已加入 ${r.queued} 项到 OCR 队列`
            : '没有需要 OCR 的图片',
        })
      }
    } catch (e) {
      setOcrScanState({ scanning: false, message: `失败: ${String(e)}` })
    }
  }

  if (loading) {
    return (
      <div className="p-5 text-center">
        <svg className="w-5 h-5 mx-auto animate-spin text-ink-4" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="mt-2 text-callout text-ink-3">检查模型状态...</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="p-5 text-center text-bad text-callout">无法检查模型状态</div>
    )
  }

  const localReady = status.localModelExists && status.embeddingReady
  const localMissing = !status.localModelExists

  return (
    <div className="p-5 space-y-5">
      <div>
        <h3 className="text-callout font-semibold text-ink mb-0.5">语义搜索模型</h3>
        <p className="text-caption text-ink-3">本地 EmbeddingGemma 2 — 文本/图像/音频/视频统一检索、零网络</p>
      </div>

      {/* 主状态 */}
      <div className={`p-3 rounded-lg ${localReady ? 'bg-ok/10' : localMissing ? 'bg-warn/10' : 'bg-fill'}`}>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${localReady ? 'bg-ok' : localMissing ? 'bg-warn' : 'bg-fill-active'}`} />
          <div className="flex-1">
            {localReady && <p className="text-caption text-ok/80">EmbeddingGemma 2 本地模型已就绪</p>}
            {localMissing && (
              <>
                <p className="text-caption text-warn/80">模型文件缺失</p>
                <p className="text-micro text-ink-3 mt-0.5">
                  开发环境：执行 <code className="bg-fill px-1 rounded">node scripts/download-models.mjs</code>
                </p>
              </>
            )}
            {status.initError && (
              <p className="text-micro text-bad/80 mt-1">{status.initError}</p>
            )}
          </div>
        </div>
      </div>

      <div className="text-micro text-ink-3">
        <p>模型存储位置</p>
        <code className="text-micro bg-fill px-2 py-1 rounded block break-all text-ink-3 mt-1">
          {status.modelsDir}
        </code>
      </div>

      {/* OCR */}
      <div className="pt-4 border-t border-line">
        <h3 className="text-callout font-semibold text-ink mb-0.5">图内文字搜索 (OCR)</h3>
        <p className="text-caption text-ink-3 mb-2">
          扫描相册里的图片文字（截图、票据、海报等），扫完后可直接搜文字。
        </p>
        <button
          onClick={startOcrScan}
          disabled={ocrScanState.scanning}
          className="w-full py-1.5 px-3 bg-fill hover:bg-fill-hover disabled:opacity-30 text-ink-2 text-callout rounded-md"
        >
          {ocrScanState.scanning ? '排队中...' : '开始扫描图内文字'}
        </button>
        {ocrScanState.message && (
          <p className={`text-caption mt-1.5 ${ocrScanState.message.startsWith('失败') ? 'text-bad' : 'text-ok'}`}>
            {ocrScanState.message}
          </p>
        )}
      </div>

      {/* 数据库备份 */}
      <div className="pt-4 border-t border-line">
        <h3 className="text-callout font-semibold text-ink mb-0.5">数据库备份</h3>
        <p className="text-caption text-ink-3 mb-2">
          每 24 小时自动备份一次 library.db（保留最近 3 份），可在此手动触发。
        </p>
        {backupStatus && (
          <div className="text-micro text-ink-3 mb-2 space-y-0.5">
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
          className="w-full py-1.5 px-3 bg-fill hover:bg-fill-hover disabled:opacity-30 text-ink-2 text-callout rounded-md"
        >
          {backupBusy ? '备份中...' : '立即备份'}
        </button>
        {backupMessage && (
          <p className={`text-caption mt-1.5 ${backupMessage.startsWith('失败') ? 'text-bad' : 'text-ok'}`}>
            {backupMessage}
          </p>
        )}
      </div>

      {/* 高级：量化档位 */}
      <div className="pt-4 border-t border-line">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-caption text-ink-3 hover:text-ink-2 transition-colors"
        >
          {showAdvanced ? '▾' : '▸'} 高级：量化档位
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-2.5">
            <p className="text-micro text-ink-4">
              q4 更小更快，q8 精度更高。切换后模型会在下次搜索 / 索引时重新加载。
            </p>

            {QUANT_FIELDS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-caption text-ink-2">{label}</span>
                <div className="flex gap-1">
                  {(['q4', 'q8'] as Quant[]).map((q) => (
                    <button
                      key={q}
                      onClick={() => saveQuantization({ [key]: q })}
                      disabled={saving || quantConfig[key] === q}
                      className={`py-1 px-2.5 text-caption rounded-md disabled:cursor-default ${
                        quantConfig[key] === q
                          ? 'bg-accent/20 text-accent'
                          : 'bg-fill hover:bg-fill-hover text-ink-2 disabled:opacity-30'
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {saveResult && (
              <p className={`text-caption ${saveResult.startsWith('失败') ? 'text-bad' : 'text-ok'}`}>
                {saveResult}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
