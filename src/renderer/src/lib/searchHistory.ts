import { useCallback, useState } from 'react'

const RECENT_KEY = 'search.recent'
const SAVED_KEY = 'search.saved'
/** 最近搜索最多记多少条 */
export const RECENT_LIMIT = 8

function load(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function store(key: string, list: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)) } catch { /* 忽略 */ }
}

/** 同一个查询只算一条：去掉首尾空白、合并连续空格 */
export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ')
}

export interface SearchHistory {
  recent: string[]
  saved: string[]
  /** 记一条最近搜索；若是上一条的延伸（继续打字），直接替换上一条 */
  addRecent: (q: string) => void
  removeRecent: (q: string) => void
  isSaved: (q: string) => boolean
  toggleSaved: (q: string) => void
}

/** 侧边栏"搜索"分组的数据：只存本机 localStorage，最近在前 */
export function useSearchHistory(): SearchHistory {
  const [recent, setRecent] = useState(() => load(RECENT_KEY))
  const [saved, setSaved] = useState(() => load(SAVED_KEY))

  const addRecent = useCallback((raw: string) => {
    const q = normalizeQuery(raw)
    if (!q) return
    setRecent((prev) => {
      const last = prev[0]
      const rest = prev.filter((x) => x !== q && !(x === last && (q.startsWith(x) || x.startsWith(q))))
      const next = [q, ...rest].slice(0, RECENT_LIMIT)
      store(RECENT_KEY, next)
      return next
    })
  }, [])

  const removeRecent = useCallback((q: string) => {
    setRecent((prev) => {
      const next = prev.filter((x) => x !== q)
      store(RECENT_KEY, next)
      return next
    })
  }, [])

  const isSaved = useCallback((raw: string) => saved.includes(normalizeQuery(raw)), [saved])

  const toggleSaved = useCallback((raw: string) => {
    const q = normalizeQuery(raw)
    if (!q) return
    setSaved((prev) => {
      const next = prev.includes(q) ? prev.filter((x) => x !== q) : [...prev, q]
      store(SAVED_KEY, next)
      return next
    })
  }, [])

  return { recent, saved, addRecent, removeRecent, isSaved, toggleSaved }
}
