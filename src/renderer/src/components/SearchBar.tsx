import { useState, useCallback, useRef, useEffect } from 'react'

interface SearchBarProps {
  onSearch: (query: string) => void
  isSearching: boolean
  resultCount?: number
}

export function SearchBar({ onSearch, isSearching, resultCount }: SearchBarProps): JSX.Element {
  const [query, setQuery] = useState('')
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
        className="w-full h-7 pl-8 pr-14 text-body rounded-md bg-fill border border-line text-ink placeholder-ink-4 focus:outline-none focus:border-accent/50 focus:bg-raised transition-colors duration-fast"
      />

      <div className="absolute inset-y-0 right-0 flex items-center pr-2 gap-1">
        {/* 结果计数 */}
        {showResultHint && (
          <span className="text-micro text-ink-4 tabular-nums">
            {resultCount} 项
          </span>
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
