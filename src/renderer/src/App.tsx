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
  const [hasSearchQuery, setHasSearchQuery] = useState(false)

  // 监听索引进度
  useEffect(() => {
    let lastThumbnailedCount = 0
    let lastIndexedCount = 0
    let lastCaptionedCount = 0

    const unsubscribe = window.api.onIndexProgress(async (progress) => {
      setIndexProgress(progress)

      const thumbnailChanged = progress.thumbnailedPhotos > lastThumbnailedCount
      const indexedChanged = progress.indexedPhotos > lastIndexedCount
      const captionChanged = progress.captionedPhotos > lastCaptionedCount

      lastThumbnailedCount = progress.thumbnailedPhotos
      lastIndexedCount = progress.indexedPhotos
      lastCaptionedCount = progress.captionedPhotos

      if (thumbnailChanged || indexedChanged || captionChanged) {
        setHasPhotos(true)

        // 刷新照片列表以更新缩略图和状态
        if (!hasSearchQuery) {
          const results = await window.api.search('')
          setSearchResults(results)
        }
      }
    })
    return unsubscribe
  }, [hasSearchQuery])

  // 初始加载
  useEffect(() => {
    const init = async () => {
      const folders = await window.api.getFolders()
      if (folders.length === 0) {
        setShowFolderManager(true)
      } else {
        const results = await window.api.search('')
        setSearchResults(results)
        if (results.length > 0) {
          setHasPhotos(true)
        }
      }
    }
    init()
  }, [])

  // 搜索处理
  const handleSearch = useCallback(async (query: string) => {
    const trimmedQuery = query.trim()
    setHasSearchQuery(!!trimmedQuery)

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

  const handleSelectPhoto = useCallback((photo: Photo) => {
    setSelectedPhoto(photo)
  }, [])

  const handleCloseDetail = useCallback(() => {
    setSelectedPhoto(null)
  }, [])

  const handleFolderManagerClose = useCallback(async () => {
    setShowFolderManager(false)
    if (!hasSearchQuery) {
      const results = await window.api.search('')
      setSearchResults(results)
      if (results.length > 0) {
        setHasPhotos(true)
      }
    }
  }, [hasSearchQuery])

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedPhoto) {
          setSelectedPhoto(null)
        } else if (showFolderManager) {
          setShowFolderManager(false)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        document.getElementById('search-input')?.focus()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowFolderManager(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedPhoto, showFolderManager])

  return (
    <div className="h-screen flex flex-col bg-surface-0">
      {/* 标题栏 */}
      <div className="titlebar h-11 flex items-center px-4 bg-surface-0/80 glass relative z-10">
        <div className="w-20" />

        <div className="flex-1 max-w-xl mx-auto">
          <SearchBar onSearch={handleSearch} isSearching={isSearching} />
        </div>

        {/* 设置按钮 */}
        <button
          onClick={() => setShowFolderManager(true)}
          className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
          title="设置 (Cmd+,)"
        >
          <svg className="w-4 h-4 text-white/50 hover:text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 overflow-hidden">
        {searchResults.length > 0 ? (
          <PhotoGrid results={searchResults} onSelect={handleSelectPhoto} isSearching={hasSearchQuery} />
        ) : hasSearchQuery ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center animate-fade-in">
              <p className="text-white/40 text-sm">没有找到匹配的照片</p>
              <p className="text-white/20 text-xs mt-1">尝试其他关键词</p>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center animate-fade-in">
              {!hasPhotos ? (
                <>
                  <p className="text-white/40 text-sm">还没有照片</p>
                  <p className="text-white/20 text-xs mt-1">添加照片文件夹开始使用</p>
                </>
              ) : (
                <p className="text-white/30 text-xs">加载中...</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 索引进度 */}
      <IndexProgress progress={indexProgress} />

      {/* 照片详情 */}
      {selectedPhoto && (
        <PhotoDetail photo={selectedPhoto} onClose={handleCloseDetail} />
      )}

      {/* 设置面板 */}
      {showFolderManager && (
        <FolderManager onClose={handleFolderManagerClose} />
      )}
    </div>
  )
}

export default App
