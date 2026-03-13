import { useState, useEffect, useCallback } from 'react'
import { SearchBar } from './components/SearchBar'
import { PhotoGrid } from './components/PhotoGrid'
import { PhotoDetail } from './components/PhotoDetail'
import { FolderManager } from './components/FolderManager'
import { IndexProgress } from './components/IndexProgress'
import type { SearchResult, Photo, IndexProgress as IndexProgressType } from '../../shared/types'

function App(): JSX.Element {
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null)
  const [showFolderManager, setShowFolderManager] = useState(false)
  const [indexProgress, setIndexProgress] = useState<IndexProgressType | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [hasPhotos, setHasPhotos] = useState(false)

  // 监听索引进度
  useEffect(() => {
    const unsubscribe = window.api.onIndexProgress((progress) => {
      setIndexProgress(progress)
      // 如果有照片被索引，更新状态
      if (progress.done > 0) {
        setHasPhotos(true)
      }
    })
    return unsubscribe
  }, [])

  // 初始加载检查是否有文件夹
  useEffect(() => {
    const checkFolders = async () => {
      const folders = await window.api.getFolders()
      if (folders.length === 0) {
        // 没有文件夹，自动打开文件夹管理器
        setShowFolderManager(true)
      }
    }
    checkFolders()
  }, [])

  // 搜索处理
  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([])
      return
    }

    setIsSearching(true)
    try {
      const results = await window.api.search(query)
      setSearchResults(results)
    } catch (error) {
      console.error('Search error:', error)
    } finally {
      setIsSearching(false)
    }
  }, [])

  // 选择照片
  const handleSelectPhoto = useCallback((photo: Photo) => {
    setSelectedPhoto(photo)
  }, [])

  // 关闭详情
  const handleCloseDetail = useCallback(() => {
    setSelectedPhoto(null)
  }, [])

  // 文件夹管理器关闭时刷新
  const handleFolderManagerClose = useCallback(() => {
    setShowFolderManager(false)
  }, [])

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ESC 关闭详情或文件夹管理器
      if (e.key === 'Escape') {
        if (selectedPhoto) {
          setSelectedPhoto(null)
        } else if (showFolderManager) {
          setShowFolderManager(false)
        }
      }
      // Cmd/Ctrl + F 聚焦搜索框
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        document.getElementById('search-input')?.focus()
      }
      // Cmd/Ctrl + , 打开设置
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowFolderManager(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedPhoto, showFolderManager])

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-gray-900">
      {/* 标题栏区域（macOS 拖拽） */}
      <div className="titlebar h-12 flex items-center px-4 border-b border-gray-200 dark:border-gray-700">
        {/* macOS 红绿灯占位 */}
        <div className="w-20" />

        {/* 搜索框 */}
        <div className="flex-1 max-w-2xl mx-auto">
          <SearchBar onSearch={handleSearch} isSearching={isSearching} />
        </div>

        {/* 设置按钮 */}
        <button
          onClick={() => setShowFolderManager(true)}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="管理文件夹 (Cmd+,)"
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 overflow-hidden">
        {searchResults.length > 0 ? (
          <PhotoGrid results={searchResults} onSelect={handleSelectPhoto} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-gray-500 dark:text-gray-400">
              <svg className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <p className="text-lg mb-2">输入关键词搜索照片</p>
              <p className="text-sm mb-4">例如：a cat, sunset, birthday party</p>
              {!hasPhotos && (
                <p className="text-xs text-gray-400">
                  提示：先添加照片文件夹，等待索引完成后即可搜索
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 索引进度条 - 始终显示 */}
      <IndexProgress progress={indexProgress} />

      {/* 照片详情 */}
      {selectedPhoto && (
        <PhotoDetail photo={selectedPhoto} onClose={handleCloseDetail} />
      )}

      {/* 文件夹管理器 */}
      {showFolderManager && (
        <FolderManager onClose={handleFolderManagerClose} />
      )}
    </div>
  )
}

export default App
