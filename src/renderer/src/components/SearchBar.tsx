import { useState, useCallback, useRef, useEffect } from 'react'

interface SearchBarProps {
  /** 当前生效的查询；外部（侧边栏最近 / 已保存）改它时输入框跟着变 */
  value: string
  onSearch: (query: string) => void
  isSearching: boolean
  resultCount?: number
  /** 当前查询是否已保存；有查询时右侧显示 ☆ */
  saved?: boolean
  onToggleSave?: () => void
}

export function SearchBar({ value, onSearch, isSearching, resultCount, saved, onToggleSave }: SearchBarProps): JSX.Element {
  const [query, setQuery] = useState(value)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout>()

  const debouncedSearch = useCallback(
    (value: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      debounceRef.current = setTimeout(() => {
        onSearch(value)
      }, 300)
    },
    [onSearch]
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value
    setQuery(value)
    debouncedSearch(value)
  }

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    onSearch(query)
  }

  const handleClear = (): void => {
    setQuery('')
    onSearch('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && query) {
      e.stopPropagation()
      handleClear()
    }
  }

  // 外部改了查询：同步输入框，并丢掉还没发出的防抖（否则会把旧文字再搜一遍）
  useEffect(() => {
    setQuery((cur) => {
      if (cur === value) return cur
      if (debounceRef.current) clearTimeout(debounceRef.current)
      return value
    })
  }, [value])

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  // 搜索结果计数提示
  const showResultHint = query.trim() && !isSearching && resultCount !== undefined

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
        {isSearching ? (
          <svg className="w-3.5 h-3.5 text-accent animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : (
          <svg className={`w-3.5 h-3.5 transition-colors ${focused ? 'text-ink-2' : 'text-ink-4'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        )}
      </div>

      <input
        ref={inputRef}
        id="search-input"
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        placeholder="搜索：物体、场景、图内文字、文件名…"
        className="w-full h-7 pl-8 pr-24 text-body rounded-md bg-fill border border-line text-ink placeholder-ink-4 focus:outline-none focus:border-accent/50 focus:bg-raised transition-colors duration-fast"
      />

      <div className="absolute inset-y-0 right-0 flex items-center pr-2 gap-1">
        {/* 结果计数 */}
        {showResultHint && (
          <span className="text-micro text-ink-4 tabular-nums">
            {resultCount} 项
          </span>
        )}
        {/* 保存搜索 */}
        {query.trim() && onToggleSave && (
          <button
            type="button"
            onClick={onToggleSave}
            title={saved ? '取消保存此搜索' : '保存此搜索'}
            aria-pressed={!!saved}
            data-save-search
            className="p-1 rounded hover:bg-fill-hover transition-colors"
          >
            <svg className={`w-3.5 h-3.5 ${saved ? 'text-accent' : 'text-ink-3 hover:text-ink-2'}`} viewBox="0 0 24 24" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
            </svg>
          </button>
        )}
        {/* 清除按钮 */}
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="p-1 rounded hover:bg-fill-hover transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-ink-3 hover:text-ink-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </form>
  )
}
