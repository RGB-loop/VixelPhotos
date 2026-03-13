import { useState, useCallback, useRef, useEffect } from 'react'

interface SearchBarProps {
  onSearch: (query: string) => void
  isSearching: boolean
}

export function SearchBar({ onSearch, isSearching }: SearchBarProps): JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout>()

  // 防抖搜索
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

  // 清理定时器
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  return (
    <form onSubmit={handleSubmit} className="relative">
      {/* 搜索图标 */}
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        {isSearching ? (
          <svg className="w-5 h-5 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : (
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        )}
      </div>

      {/* 输入框 */}
      <input
        ref={inputRef}
        id="search-input"
        type="text"
        value={query}
        onChange={handleChange}
        placeholder="用自然语言搜索照片..."
        className="search-input w-full pl-10 pr-10 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:border-primary-500 dark:focus:border-primary-400 transition-colors"
      />

      {/* 清除按钮 */}
      {query && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute inset-y-0 right-0 pr-3 flex items-center"
        >
          <svg className="w-5 h-5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </form>
  )
}
