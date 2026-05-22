import { useState, useEffect, useCallback, useRef } from 'react'
import { SearchBar } from './components/SearchBar'
import { PhotoGrid } from './components/PhotoGrid'
import { PhotoDetail } from './components/PhotoDetail'
import { FolderManager } from './components/FolderManager'
import { IndexProgress } from './components/IndexProgress'
import { MapView } from './components/MapView'
import { PeopleView } from './components/PeopleView'
import type { SearchResult, Photo, IndexProgress as IndexProgressType } from '../../shared/types'

type ViewMode = 'grid' | 'map' | 'people'

const VIEW_ICONS: Record<ViewMode, { title: string; path: string }> = {
  grid: {
    title: '照片',
    path: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
  },
  map: {
    title: '地图',
    path: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z',
  },
  people: {
    title: '人物',
    path: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  },
}

function App(): JSX.Element {
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null)
  const [showFolderManager, setShowFolderManager] = useState(false)
  const [indexProgress, setIndexProgress] = useState<IndexProgressType | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [hasPhotos, setHasPhotos] = useState(false)
  const [hasSearchQuery, setHasSearchQuery] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showDateFilter, setShowDateFilter] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const currentQuery = useRef('')

  const doSearch = useCallback(async (query: string, from?: string, to?: string) => {
    const options = (from || to) ? { dateFrom: from || undefined, dateTo: to || undefined } : undefined
    return window.api.search(query, undefined, options)
  }, [])

  // 监听索引进度
  useEffect(() => {
    let lastThumbnailedCount = 0
    let lastIndexedCount = 0
    let lastOcrCount = 0

    const unsubscribe = window.api.onIndexProgress(async (progress) => {
      setIndexProgress(progress)
      const thumbnailChanged = progress.thumbnailedPhotos > lastThumbnailedCount
      const indexedChanged = progress.indexedPhotos > lastIndexedCount
      const ocrChanged = (progress.ocrPhotos || 0) > lastOcrCount
      lastThumbnailedCount = progress.thumbnailedPhotos
      lastIndexedCount = progress.indexedPhotos
      lastOcrCount = progress.ocrPhotos || 0
      if (thumbnailChanged || indexedChanged || ocrChanged) {
        setHasPhotos(true)
        if (!hasSearchQuery && viewMode === 'grid') {
          const results = await doSearch('')
          setSearchResults(results)
        }
      }
    })
    return unsubscribe
  }, [hasSearchQuery, doSearch, viewMode])

  // 初始加载
  useEffect(() => {
    const init = async () => {
      const folders = await window.api.getFolders()
      if (folders.length === 0) {
        setShowFolderManager(true)
      } else {
        const results = await doSearch('')
        setSearchResults(results)
        if (results.length > 0) setHasPhotos(true)
      }
    }
    init()
  }, [doSearch])

  const handleSearch = useCallback(async (query: string) => {
    const trimmedQuery = query.trim()
    currentQuery.current = query
    setHasSearchQuery(!!trimmedQuery)
    // 搜索时自动切回网格视图
    if (trimmedQuery && viewMode !== 'grid') setViewMode('grid')
    setIsSearching(true)
    try {
      const results = await doSearch(query, dateFrom, dateTo)
      setSearchResults(results)
    } catch (error) {
      console.error('Search error:', error)
    } finally {
      setIsSearching(false)
    }
  }, [doSearch, dateFrom, dateTo, viewMode])

  const handleDateFilterChange = useCallback(async (from: string, to: string) => {
    setDateFrom(from)
    setDateTo(to)
    setIsSearching(true)
    try {
      const results = await doSearch(currentQuery.current, from, to)
      setSearchResults(results)
    } catch (error) {
      console.error('Filter error:', error)
    } finally {
      setIsSearching(false)
    }
  }, [doSearch])

  const handleSelectPhoto = useCallback((photo: Photo) => setSelectedPhoto(photo), [])
  const handleCloseDetail = useCallback(() => setSelectedPhoto(null), [])

  const handleFolderManagerClose = useCallback(async () => {
    setShowFolderManager(false)
    if (!hasSearchQuery) {
      const results = await doSearch('')
      setSearchResults(results)
      if (results.length > 0) setHasPhotos(true)
    }
  }, [hasSearchQuery, doSearch])

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedPhoto) setSelectedPhoto(null)
        else if (showFolderManager) setShowFolderManager(false)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        if (viewMode !== 'grid') setViewMode('grid')
        document.getElementById('search-input')?.focus()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowFolderManager(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedPhoto, showFolderManager, viewMode])

  const hasDateFilter = !!(dateFrom || dateTo)

  return (
    <div className="h-screen flex flex-col bg-surface-0">
      {/* 标题栏 */}
      <div className="titlebar h-11 flex items-center px-4 bg-surface-1/60 glass relative z-10 gap-3">
        {/* macOS 红绿灯占位 */}
        <div className="w-[68px] flex-shrink-0" />

        {/* 视图切换 */}
        <div className="flex items-center bg-white/5 rounded-lg p-0.5 flex-shrink-0">
          {(Object.entries(VIEW_ICONS) as [ViewMode, typeof VIEW_ICONS['grid']][]).map(([mode, { title, path }]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-2 py-1 rounded-md text-[11px] flex items-center gap-1 transition-all ${
                viewMode === mode
                  ? 'bg-white/10 text-white/80'
                  : 'text-white/30 hover:text-white/50'
              }`}
              title={title}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
              </svg>
              <span className="hidden sm:inline">{title}</span>
            </button>
          ))}
        </div>

        {/* 搜索框 — 仅在网格视图显示 */}
        {viewMode === 'grid' && (
          <div className="flex-1 max-w-lg">
            <SearchBar
              onSearch={handleSearch}
              isSearching={isSearching}
              resultCount={hasSearchQuery ? searchResults.length : undefined}
            />
          </div>
        )}
        {viewMode !== 'grid' && <div className="flex-1" />}

        {/* 右侧工具 */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* 日期过滤 — 仅网格视图 */}
          {viewMode === 'grid' && (
            <button
              onClick={() => setShowDateFilter(!showDateFilter)}
              className={`p-1.5 rounded-md transition-colors ${
                showDateFilter || hasDateFilter
                  ? 'bg-accent/20 text-accent'
                  : 'hover:bg-white/10 text-white/25'
              }`}
              title="时间过滤"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </button>
          )}
          {/* 设置 */}
          <button
            onClick={() => setShowFolderManager(true)}
            className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
            title="设置 (Cmd+,)"
          >
            <svg className="w-4 h-4 text-white/25 hover:text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 日期过滤栏 */}
      {showDateFilter && viewMode === 'grid' && (
        <div className="px-4 py-2 bg-surface-1 border-b border-white/5 flex items-center gap-3 animate-fade-in">
          <span className="text-[11px] text-white/30">时间</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => handleDateFilterChange(e.target.value, dateTo)}
            className="px-2 py-1 text-[11px] bg-surface-2 border border-white/10 rounded text-white/70 focus:outline-none focus:border-white/20"
          />
          <span className="text-white/15 text-[11px]">—</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => handleDateFilterChange(dateFrom, e.target.value)}
            className="px-2 py-1 text-[11px] bg-surface-2 border border-white/10 rounded text-white/70 focus:outline-none focus:border-white/20"
          />
          {hasDateFilter && (
            <button
              onClick={() => { handleDateFilterChange('', ''); setShowDateFilter(false) }}
              className="text-[10px] text-white/30 hover:text-white/60 px-1.5 py-0.5 rounded hover:bg-white/5"
            >
              清除
            </button>
          )}
        </div>
      )}

      {/* 主内容区 */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'people' ? (
          <PeopleView onSelectPhoto={handleSelectPhoto} />
        ) : viewMode === 'map' ? (
          <MapView onSelect={handleSelectPhoto} />
        ) : searchResults.length > 0 ? (
          <PhotoGrid results={searchResults} onSelect={handleSelectPhoto} isSearching={hasSearchQuery} />
        ) : hasSearchQuery ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center animate-fade-in">
              <svg className="w-10 h-10 mx-auto mb-3 text-white/10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <p className="text-white/40 text-sm">没有找到匹配的照片</p>
              <p className="text-white/20 text-xs mt-2">试试其他关键词，或检查是否已配置 Embedding API</p>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center animate-fade-in">
              {!hasPhotos ? (
                <>
                  <svg className="w-10 h-10 mx-auto mb-3 text-white/10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-white/40 text-sm">还没有照片</p>
                  <button
                    onClick={() => setShowFolderManager(true)}
                    className="mt-3 px-4 py-1.5 bg-white/5 hover:bg-white/10 text-white/50 text-xs rounded-md transition-colors"
                  >
                    添加照片文件夹
                  </button>
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
        <PhotoDetail photo={selectedPhoto} onSelect={handleSelectPhoto} onClose={handleCloseDetail} />
      )}

      {/* 设置面板 */}
      {showFolderManager && (
        <FolderManager onClose={handleFolderManagerClose} />
      )}
    </div>
  )
}

export default App
