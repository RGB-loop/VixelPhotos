import { useState, useEffect, useCallback } from 'react'
import type { WatchedFolder } from '../../../shared/types'
import { ModelStatus } from './ModelStatus'

interface FolderManagerProps {
  onClose: () => void
}

interface DeleteConfirmation {
  folder: WatchedFolder
  isOpen: boolean
}

export function FolderManager({ onClose }: FolderManagerProps): JSX.Element {
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'folders' | 'model'>('folders')
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmation | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    const loadFolders = async (): Promise<void> => {
      const data = await window.api.getFolders()
      setFolders(data)
      setIsLoading(false)
    }
    loadFolders()
  }, [])

  const handleAddFolder = useCallback(async () => {
    const path = await window.api.selectFolder()
    if (path) {
      const folder = await window.api.addFolder(path)
      setFolders((prev) => [folder, ...prev])
    }
  }, [])

  const handleRequestRemove = useCallback((folder: WatchedFolder) => {
    setDeleteConfirm({ folder, isOpen: true })
  }, [])

  const handleConfirmRemove = useCallback(async () => {
    if (!deleteConfirm) return

    setIsDeleting(true)
    try {
      await window.api.removeFolder(deleteConfirm.folder.id)
      setFolders((prev) => prev.filter((f) => f.id !== deleteConfirm.folder.id))
      setDeleteConfirm(null)
    } finally {
      setIsDeleting(false)
    }
  }, [deleteConfirm])

  const handleCancelRemove = useCallback(() => {
    setDeleteConfirm(null)
  }, [])

  const handleBackdropClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  const getFolderName = (path: string): string => {
    return path.split('/').pop() || path
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 modal-overlay"
      onClick={handleBackdropClick}
    >
      <div className="bg-surface-2 rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col border border-white/10 animate-fade-in">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5">
          <h2 className="text-sm font-semibold text-white">设置</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-white/10 transition-colors"
          >
            <svg className="w-4 h-4 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 标签页 */}
        <div className="flex border-b border-white/5">
          <button
            onClick={() => setActiveTab('folders')}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
              activeTab === 'folders'
                ? 'text-accent border-b-2 border-accent'
                : 'text-white/40 hover:text-white/60'
            }`}
          >
            照片文件夹
          </button>
          <button
            onClick={() => setActiveTab('model')}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
              activeTab === 'model'
                ? 'text-accent border-b-2 border-accent'
                : 'text-white/40 hover:text-white/60'
            }`}
          >
            AI 模型
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-auto">
          {activeTab === 'folders' ? (
            <>
              <div className="p-5">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <svg className="w-6 h-6 text-white/20 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                ) : folders.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-white/30 text-sm mb-1">还没有添加照片文件夹</p>
                    <p className="text-white/15 text-xs">添加文件夹后自动扫描并索引</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {folders.map((folder) => (
                      <div
                        key={folder.id}
                        className="flex items-center gap-3 p-2.5 rounded-lg bg-white/5 hover:bg-white/8 transition-colors"
                      >
                        <svg className="w-4 h-4 text-accent/60 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-white/80 truncate">
                            {getFolderName(folder.path)}
                          </p>
                          <div className="flex items-center gap-1.5 text-[10px] text-white/25">
                            <span className="truncate">{folder.path}</span>
                            {folder.photoCount !== undefined && folder.photoCount > 0 && (
                              <>
                                <span>·</span>
                                <span className="flex-shrink-0">{folder.photoCount} 张</span>
                              </>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRequestRemove(folder)}
                          className="p-1 rounded hover:bg-white/10 transition-colors text-white/20 hover:text-red-400"
                          title="移除"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="px-5 py-3.5 border-t border-white/5">
                <button
                  onClick={handleAddFolder}
                  className="w-full py-2 px-3 bg-white/8 hover:bg-white/12 text-white/70 text-xs rounded-md transition-colors flex items-center justify-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  添加照片文件夹
                </button>
              </div>
            </>
          ) : (
            <ModelStatus />
          )}
        </div>
      </div>

      {/* 删除确认对话框 */}
      {deleteConfirm?.isOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 modal-overlay" style={{ zIndex: 950 }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isDeleting) {
              handleCancelRemove()
            }
          }}
        >
          <div className="bg-surface-2 rounded-xl shadow-2xl max-w-sm w-full p-5 border border-white/10">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-white">
                确认移除文件夹
              </h3>
            </div>

            <div className="mb-5 space-y-2.5">
              <p className="text-xs text-white/60">
                确定要移除 <span className="font-medium text-white/80">"{getFolderName(deleteConfirm.folder.path)}"</span> 吗？
              </p>

              {deleteConfirm.folder.photoCount !== undefined && deleteConfirm.folder.photoCount > 0 && (
                <div className="p-2.5 bg-amber-500/10 rounded-lg">
                  <p className="text-xs text-amber-300/80">
                    该文件夹包含 <span className="font-semibold">{deleteConfirm.folder.photoCount}</span> 张已索引的照片，将从搜索库中移除。
                  </p>
                </div>
              )}

              <p className="text-[10px] text-white/25">
                此操作只会从 Vixel 中移除索引，不会删除原始照片文件。
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCancelRemove}
                disabled={isDeleting}
                className="flex-1 py-2 px-3 bg-white/8 hover:bg-white/12 text-white/60 text-xs rounded-md transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleConfirmRemove}
                disabled={isDeleting}
                className="flex-1 py-2 px-3 bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs rounded-md transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {isDeleting ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    移除中...
                  </>
                ) : (
                  '确认移除'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
