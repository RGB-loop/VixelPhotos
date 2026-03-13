import { useState, useEffect, useCallback } from 'react'
import type { WatchedFolder } from '../../../shared/types'
import { ModelStatus } from './ModelStatus'

interface FolderManagerProps {
  onClose: () => void
}

export function FolderManager({ onClose }: FolderManagerProps): JSX.Element {
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'folders' | 'model'>('folders')

  // 加载文件夹列表
  useEffect(() => {
    const loadFolders = async (): Promise<void> => {
      const data = await window.api.getFolders()
      setFolders(data)
      setIsLoading(false)
    }
    loadFolders()
  }, [])

  // 添加文件夹
  const handleAddFolder = useCallback(async () => {
    const path = await window.api.selectFolder()
    if (path) {
      const folder = await window.api.addFolder(path)
      setFolders((prev) => [folder, ...prev])
    }
  }, [])

  // 移除文件夹
  const handleRemoveFolder = useCallback(async (id: number) => {
    await window.api.removeFolder(id)
    setFolders((prev) => prev.filter((f) => f.id !== id))
  }, [])

  // 点击背景关闭
  const handleBackdropClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">设置</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 标签页 */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setActiveTab('folders')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              activeTab === 'folders'
                ? 'text-primary-600 border-b-2 border-primary-600'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            照片文件夹
          </button>
          <button
            onClick={() => setActiveTab('model')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              activeTab === 'model'
                ? 'text-primary-600 border-b-2 border-primary-600'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            AI 模型
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-auto">
          {activeTab === 'folders' ? (
            <>
              <div className="p-6">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <svg className="w-8 h-8 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                ) : folders.length === 0 ? (
                  <div className="text-center py-8">
                    <svg className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <p className="text-gray-500 dark:text-gray-400 mb-4">还没有添加任何照片文件夹</p>
                    <p className="text-gray-400 dark:text-gray-500 text-sm">添加文件夹后，Vixel 会自动扫描并索引其中的照片</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {folders.map((folder) => (
                      <div
                        key={folder.id}
                        className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
                      >
                        <svg className="w-5 h-5 text-primary-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {folder.path.split('/').pop()}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{folder.path}</p>
                        </div>
                        <button
                          onClick={() => handleRemoveFolder(folder.id)}
                          className="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-400 hover:text-red-500"
                          title="移除此文件夹"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 底部操作栏 */}
              <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={handleAddFolder}
                  className="w-full py-2.5 px-4 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
    </div>
  )
}
