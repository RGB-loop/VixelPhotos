import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { PhotoGrid } from './components/PhotoGrid'
import { PhotoDetail } from './components/PhotoDetail'
import { FolderManager } from './components/FolderManager'
import { MapView } from './components/MapView'
import { PeopleView } from './components/PeopleView'
import { TaskDrawer } from './components/tasks/TaskDrawer'
import { Sidebar, LIBRARY_ITEMS, SIDEBAR_MIN, SIDEBAR_MAX, folderName, type Source } from './components/shell/Sidebar'
import { Toolbar } from './components/shell/Toolbar'
import { StatusBar, THUMB_MIN, THUMB_MAX } from './components/shell/StatusBar'
import { Icon } from './components/shell/icons'
import { countLine } from './lib/format'
import type {
  SearchResult, Photo, LibraryCounts, WatchedFolder, MenuCommand,
  IndexProgress as IndexProgressType,
} from '../../shared/types'

/** 空查询浏览时一次取够整个资料库（网格是虚拟化的，渲染成本与总数无关） */
const BROWSE_LIMIT = 20000

// 外壳偏好只存本机，读写失败（隐私模式 / 被清空）时回落默认值
function loadPref(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return v >= min && v <= max ? v : fallback
  } catch {
    return fallback
  }
}
function savePref(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* 忽略 */ }
}

function App(): JSX.Element {
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [showFolderManager, setShowFolderManager] = useState(false)
  const [indexProgress, setIndexProgress] = useState<IndexProgressType | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showDateFilter, setShowDateFilter] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [source, setSource] = useState<Source>({ type: 'library', kind: 'all' })
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try { return localStorage.getItem('shell.sidebarHidden') === '1' } catch { return false }
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => loadPref('shell.sidebarWidth', 232, SIDEBAR_MIN, SIDEBAR_MAX))
  const [thumbSize, setThumbSize] = useState(() => loadPref('shell.thumbSize', 200, THUMB_MIN, THUMB_MAX))

  const hasSearchQuery = !!query.trim()
  const isGrid = source.type === 'library' || source.type === 'folder'

  // 查询条件放 ref：索引进度刷新等所有 doSearch 调用都自动带上当前来源 + 日期，
  // 不用每个调用点各自传参，也不会因闭包拿到旧值
  const filters = useRef({ query: '', from: '', to: '', source })

  const doSearch = useCallback(async (): Promise<SearchResult[]> => {
    const { query: q, from, to, source: src } = filters.current
    const kind = src.type === 'library' && src.kind !== 'all' ? src.kind : undefined
    const folderId = src.type === 'folder' ? src.id : undefined
    const options = (from || to || kind || folderId != null)
      ? { dateFrom: from || undefined, dateTo: to || undefined, kind, folderId }
      : undefined
    return window.api.search(q, q.trim() ? undefined : BROWSE_LIMIT, options)
  }, [])

  const runSearch = useCallback(async () => {
    setIsSearching(true)
    try {
      setSearchResults(await doSearch())
    } catch (error) {
      console.error('Search error:', error)
    } finally {
      setIsSearching(false)
    }
  }, [doSearch])

  const refreshLibrary = useCallback(async () => {
    const [c, f] = await Promise.all([window.api.getLibraryCounts(), window.api.getFolders()])
    setCounts(c)
    setFolders(f)
    return f
  }, [])

  // 初始加载
  useEffect(() => {
    refreshLibrary().then((f) => {
      if (f.length === 0) setShowFolderManager(true)
      else runSearch()
    })
  }, [refreshLibrary, runSearch])

  // 索引进度：照片数变化时节流刷新计数和（无查询时的）网格
  useEffect(() => {
    let last = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.api.onIndexProgress((progress) => {
      setIndexProgress(progress)
      const sig = `${progress.totalPhotos}/${progress.thumbnailedPhotos}/${progress.indexedPhotos}/${progress.ocrPhotos || 0}`
      if (sig === last) return
      last = sig
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        refreshLibrary()
        if (!filters.current.query.trim() && filters.current.source.type !== 'map' && filters.current.source.type !== 'people') {
          doSearch().then(setSearchResults).catch(() => {})
        }
      }, 1500)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [doSearch, refreshLibrary])

  const handleSelectSource = useCallback((next: Source) => {
    setSource(next)
    filters.current = { ...filters.current, source: next }
    if (next.type === 'library' || next.type === 'folder') runSearch()
  }, [runSearch])

  const handleSearch = useCallback((q: string) => {
    setQuery(q)
    filters.current = { ...filters.current, query: q }
    // 在地图 / 人物里输入查询：回到当前资料库
    if (q.trim() && (filters.current.source.type === 'map' || filters.current.source.type === 'people')) {
      const back: Source = { type: 'library', kind: 'all' }
      setSource(back)
      filters.current.source = back
    }
    runSearch()
  }, [runSearch])

  const handleDateFilterChange = useCallback((from: string, to: string) => {
    setDateFrom(from)
    setDateTo(to)
    filters.current = { ...filters.current, from, to }
    runSearch()
  }, [runSearch])

  const handleAddFolder = useCallback(async () => {
    const path = await window.api.selectFolder()
    if (!path) return
    const folder = await window.api.addFolder(path)
    await refreshLibrary()
    handleSelectSource({ type: 'folder', id: folder.id })
  }, [refreshLibrary, handleSelectSource])

  const toggleSidebar = useCallback(() => {
    setSidebarHidden((h) => {
      savePref('shell.sidebarHidden', h ? '0' : '1')
      return !h
    })
  }, [])

  const handleSidebarResize = useCallback((w: number) => {
    setSidebarWidth(w)
    savePref('shell.sidebarWidth', String(w))
  }, [])

  const handleThumbSize = useCallback((size: number) => {
    const clamped = Math.min(THUMB_MAX, Math.max(THUMB_MIN, size))
    setThumbSize(clamped)
    savePref('shell.thumbSize', String(clamped))
  }, [])

  const handleSelect = useCallback((result: SearchResult) => setSelected(result), [])
  // 地图 / 人物视图只给 Photo，没有搜索上下文
  const handleSelectPhoto = useCallback((photo: Photo) => setSelected({ photo, score: 0 }), [])
  const handleCloseDetail = useCallback(() => setSelected(null), [])
  const handleCloseTasks = useCallback(() => setShowTasks(false), [])

  const handleFolderManagerClose = useCallback(async () => {
    setShowFolderManager(false)
    const f = await refreshLibrary()
    // 当前选中的文件夹被移除了：回到全部
    const src = filters.current.source
    if (src.type === 'folder' && !f.some((x) => x.id === src.id)) handleSelectSource({ type: 'library', kind: 'all' })
    else runSearch()
  }, [refreshLibrary, runSearch, handleSelectSource])

  // 原生菜单命令（快捷键由菜单注册，渲染进程不再自己监听 ⌘F / ⌘,）
  const menuHandler = useRef<(cmd: MenuCommand) => void>(() => {})
  menuHandler.current = (cmd) => {
    switch (cmd) {
      case 'source:all': case 'source:image': case 'source:video': case 'source:audio':
        handleSelectSource({ type: 'library', kind: cmd.slice(7) as 'all' })
        break
      case 'source:map': handleSelectSource({ type: 'map' }); break
      case 'source:people': handleSelectSource({ type: 'people' }); break
      case 'find':
        if (!isGrid) handleSelectSource({ type: 'library', kind: 'all' })
        setTimeout(() => document.getElementById('search-input')?.focus(), 0)
        break
      case 'toggle-sidebar': toggleSidebar(); break
      case 'zoom-in': handleThumbSize(thumbSize + 40); break
      case 'zoom-out': handleThumbSize(thumbSize - 40); break
      case 'settings': setShowFolderManager(true); break
      case 'activity': setShowTasks((s) => !s); break
      case 'add-folder': handleAddFolder(); break
    }
  }
  useEffect(() => window.api.onMenuCommand((cmd) => menuHandler.current(cmd)), [])

  // Esc：关详情 / 设置（抽屉自己处理 Esc）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (selected) setSelected(null)
      else if (showFolderManager) setShowFolderManager(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected, showFolderManager])

  const hasDateFilter = !!(dateFrom || dateTo)
  const libraryEmpty = counts !== null && counts.all === 0

  const title = useMemo(() => {
    switch (source.type) {
      case 'library': return LIBRARY_ITEMS.find((i) => i.kind === source.kind)?.label ?? '全部'
      case 'folder': {
        const f = folders.find((x) => x.id === source.id)
        return f ? folderName(f.path) : '文件夹'
      }
      case 'map': return '地图'
      case 'people': return '人物'
    }
  }, [source, folders])

  const breakdown = useMemo(() => countLine(searchResults.map((r) => r.photo)), [searchResults])
  const subtitle = isGrid
    ? hasSearchQuery
      ? `“${query.trim()}” · ${searchResults.length.toLocaleString()} 项`
      : searchResults.length > 0 ? `${searchResults.length.toLocaleString()} 项${hasDateFilter ? ' · 已按时间过滤' : ''}` : undefined
    : undefined

  return (
    <div className="h-screen flex bg-canvas text-ink">
      {!sidebarHidden && (
        <Sidebar
          width={sidebarWidth}
          onResize={handleSidebarResize}
          source={source}
          onSelect={handleSelectSource}
          counts={counts}
          folders={folders}
          onAddFolder={handleAddFolder}
        />
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <Toolbar
          title={title}
          subtitle={subtitle}
          sidebarHidden={sidebarHidden}
          onToggleSidebar={toggleSidebar}
          showSearch={isGrid}
          onSearch={handleSearch}
          isSearching={isSearching}
          resultCount={hasSearchQuery ? searchResults.length : undefined}
          dateActive={showDateFilter || hasDateFilter}
          onToggleDate={() => setShowDateFilter((s) => !s)}
          onOpenSettings={() => setShowFolderManager(true)}
        />

        {/* 日期过滤栏 */}
        {showDateFilter && isGrid && (
          <div className="h-9 flex-shrink-0 px-4 bg-bar border-b border-line flex items-center gap-3 animate-fade-in">
            <span className="text-caption text-ink-3">时间</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => handleDateFilterChange(e.target.value, dateTo)}
              className="h-6 px-2 text-caption bg-fill border border-line rounded text-ink focus:outline-none focus:border-accent/50"
            />
            <span className="text-ink-4 text-caption">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => handleDateFilterChange(dateFrom, e.target.value)}
              className="h-6 px-2 text-caption bg-fill border border-line rounded text-ink focus:outline-none focus:border-accent/50"
            />
            {hasDateFilter && (
              <button
                onClick={() => { handleDateFilterChange('', ''); setShowDateFilter(false) }}
                className="text-caption text-ink-3 hover:text-ink px-1.5 py-0.5 rounded hover:bg-fill"
              >
                清除
              </button>
            )}
          </div>
        )}

        {/* 主内容区 */}
        <main className="flex-1 min-h-0 overflow-hidden">
          {source.type === 'people' ? (
            <PeopleView onSelectPhoto={handleSelectPhoto} />
          ) : source.type === 'map' ? (
            <MapView onSelect={handleSelectPhoto} />
          ) : searchResults.length > 0 ? (
            <PhotoGrid results={searchResults} onSelect={handleSelect} isSearching={hasSearchQuery} thumbSize={thumbSize} />
          ) : libraryEmpty ? (
            <EmptyState
              icon="image"
              title="资料库还是空的"
              hint="添加一个文件夹，Vixel 会在本机为其中的图片、视频和音频建立索引"
              action={{ label: '添加文件夹…', onClick: handleAddFolder }}
            />
          ) : counts === null || isSearching ? null : (
            <EmptyState
              icon="search"
              title={hasSearchQuery ? '没有找到匹配的内容' : '这里没有内容'}
              hint={hasSearchQuery
                ? '试试其他关键词、图内的文字片段，或换种说法'
                : hasDateFilter ? '试试放宽时间过滤' : '换个类别或文件夹看看'}
            />
          )}
        </main>

        <StatusBar
          progress={indexProgress}
          itemCount={isGrid ? searchResults.length : counts?.all ?? 0}
          breakdown={breakdown}
          onOpenActivity={() => setShowTasks(true)}
          thumbSize={isGrid ? thumbSize : undefined}
          onThumbSize={handleThumbSize}
        />
      </div>

      <TaskDrawer open={showTasks} onClose={handleCloseTasks} progress={indexProgress} />

      {/* 详情 */}
      {selected && (
        <PhotoDetail
          result={selected}
          siblings={isGrid ? searchResults : undefined}
          onSelect={handleSelect}
          onClose={handleCloseDetail}
        />
      )}

      {/* 设置面板 */}
      {showFolderManager && (
        <FolderManager onClose={handleFolderManagerClose} />
      )}
    </div>
  )
}

function EmptyState({ icon, title, hint, action }: {
  icon: 'image' | 'search'
  title: string
  hint: string
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-xs text-center animate-fade-in">
        <Icon name={icon} className="w-10 h-10 mx-auto mb-3 text-ink-ghost" />
        <p className="text-ink-2 text-body">{title}</p>
        <p className="text-ink-4 text-callout mt-1.5">{hint}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-4 h-7 px-3 bg-accent text-black/85 text-callout font-medium rounded-md hover:brightness-110 transition duration-fast"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}

export default App
