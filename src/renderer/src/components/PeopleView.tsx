import { useEffect, useState, useCallback } from 'react'
import type { Person, Photo, SearchResult } from '../../../shared/types'

interface PeopleViewProps {
  onSelectPhoto: (photo: Photo) => void
}

export function PeopleView({ onSelectPhoto }: PeopleViewProps): JSX.Element {
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState('')
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null)
  const [personPhotos, setPersonPhotos] = useState<SearchResult[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [faceThumbs, setFaceThumbs] = useState<Map<number, string>>(new Map())

  const loadPeople = useCallback(async () => {
    const result = await window.api.getPeople()
    setPeople(result)
    setLoading(false)

    // 加载封面人脸缩略图
    const thumbs = new Map<number, string>()
    await Promise.all(
      result.map(async (p) => {
        if (p.coverFaceId) {
          const thumb = await window.api.getFaceThumbnail(p.coverFaceId)
          if (thumb) thumbs.set(p.id, thumb)
        }
      })
    )
    setFaceThumbs(thumbs)
  }, [])

  useEffect(() => {
    loadPeople()
  }, [loadPeople])

  const handleStartScan = async () => {
    setScanning(true)
    setScanProgress('正在初始化模型...')
    try {
      const result = await window.api.startFaceScan()
      if (result.error) {
        setScanProgress(`扫描失败: ${result.error}`)
        setScanning(false)
        return
      }
      setScanProgress(`已入队 ${result.queued} 张图片，正在处理...`)
      // 轮询进度
      const poll = setInterval(async () => {
        const updated = await window.api.getPeople()
        setPeople(updated)
        if (updated.length > 0) {
          // 加载新的封面
          const thumbs = new Map<number, string>()
          await Promise.all(
            updated.map(async (p) => {
              if (p.coverFaceId) {
                const thumb = await window.api.getFaceThumbnail(p.coverFaceId)
                if (thumb) thumbs.set(p.id, thumb)
              }
            })
          )
          setFaceThumbs(thumbs)
        }
      }, 5000)
      // 60 秒后停止轮询
      setTimeout(() => {
        clearInterval(poll)
        setScanning(false)
        loadPeople()
      }, 60000)
    } catch (e) {
      setScanProgress(`扫描失败: ${e}`)
      setScanning(false)
    }
  }

  const handleSelectPerson = async (person: Person) => {
    setSelectedPerson(person)
    const photos = await window.api.getPersonPhotos(person.id, 100)
    setPersonPhotos(photos)
  }

  const handleToggleSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleMerge = async () => {
    if (selectedIds.size < 2) return
    const ids = Array.from(selectedIds)
    // 优先保留有名字的
    const target = people.find((p) => ids.includes(p.id) && p.name) || people.find((p) => ids.includes(p.id))
    if (!target) return
    const sourceIds = ids.filter((id) => id !== target.id)
    await window.api.mergePeople(target.id, sourceIds)
    setSelectedIds(new Set())
    loadPeople()
  }

  const handleSaveName = async (personId: number) => {
    await window.api.setPersonName(personId, editName)
    setEditingId(null)
    loadPeople()
  }

  // 人物照片子视图
  if (selectedPerson) {
    return (
      <div className="h-full flex flex-col bg-surface-0">
        <div className="px-4 py-3 flex items-center gap-3 border-b border-line">
          <button
            onClick={() => setSelectedPerson(null)}
            className="p-1 rounded hover:bg-fill-hover text-ink-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            {faceThumbs.get(selectedPerson.id) && (
              <img src={faceThumbs.get(selectedPerson.id)} className="w-7 h-7 rounded-full object-cover" />
            )}
            <span className="text-body text-ink font-medium">
              {selectedPerson.name || '未命名'}
            </span>
            <span className="text-callout text-ink-3">{selectedPerson.photoCount} 张图片</span>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-0.5">
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-0.5">
            {personPhotos.map((r) => (
              <PhotoThumb key={r.photo.id} photo={r.photo} onClick={() => onSelectPhoto(r.photo)} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // 空状态
  if (!loading && people.length === 0 && !scanning) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-0">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 text-ink-ghost" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p className="text-ink-3 text-body mb-3">尚未扫描人脸</p>
          <button
            onClick={handleStartScan}
            className="px-4 py-2 bg-accent/20 hover:bg-accent/30 text-accent text-callout rounded-md transition-colors"
          >
            开始扫描人脸
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-0">
        <p className="text-ink-3 text-callout">加载中...</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-surface-0">
      {/* 扫描状态 */}
      {scanning && (
        <div className="px-4 py-2 bg-accent/10 text-accent text-callout flex items-center gap-2">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {scanProgress}
        </div>
      )}

      {/* 人物网格 */}
      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-4">
          {people.map((person) => (
            <div
              key={person.id}
              onClick={() => handleSelectPerson(person)}
              className="cursor-pointer group relative"
            >
              {/* 勾选框 */}
              <div
                onClick={(e) => handleToggleSelect(person.id, e)}
                className={`absolute top-1 left-1 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                  selectedIds.has(person.id)
                    ? 'bg-accent border-accent'
                    : 'border-line-heavy opacity-0 group-hover:opacity-100'
                }`}
              >
                {selectedIds.has(person.id) && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>

              {/* 人脸缩略图 */}
              <div className="w-full aspect-square rounded-full overflow-hidden bg-surface-3 mx-auto mb-2">
                {faceThumbs.get(person.id) ? (
                  <img src={faceThumbs.get(person.id)} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-ink-ghost">
                    <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                )}
              </div>

              {/* 名字 */}
              {editingId === person.id ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName(person.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={() => handleSaveName(person.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full text-center text-callout bg-fill border border-line-heavy rounded px-1 py-0.5 text-ink focus:outline-none"
                />
              ) : (
                <p
                  className="text-center text-callout text-ink-2 truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingId(person.id)
                    setEditName(person.name || '')
                  }}
                >
                  {person.name || '未命名'}
                </p>
              )}
              <p className="text-center text-micro text-ink-4 mt-0.5">{person.photoCount} 张图片</p>
            </div>
          ))}
        </div>

        {!scanning && people.length > 0 && (
          <div className="text-center mt-6">
            <button
              onClick={handleStartScan}
              className="text-micro text-ink-4 hover:text-ink-3"
            >
              重新扫描
            </button>
          </div>
        )}
      </div>

      {/* 合并浮动按钮 */}
      {selectedIds.size >= 2 && (
        <div className="px-4 py-3 border-t border-line bg-surface-1 animate-fade-in">
          <button
            onClick={handleMerge}
            className="w-full py-2 bg-accent/20 hover:bg-accent/30 text-accent text-callout rounded-md transition-colors"
          >
            合并选中 ({selectedIds.size})
          </button>
        </div>
      )}
    </div>
  )
}

/** 简单的照片缩略图（复用于 PersonPhotos） */
function PhotoThumb({ photo, onClick }: { photo: Photo; onClick: () => void }) {
  const [thumb, setThumb] = useState<string>('')

  useEffect(() => {
    window.api.getThumbnailData(photo.id).then((data) => {
      if (data) setThumb(data)
    })
  }, [photo.id])

  return (
    <div
      className="aspect-square overflow-hidden cursor-pointer bg-surface-2 hover:brightness-110"
      onClick={onClick}
    >
      {thumb ? (
        <img src={thumb} alt={photo.fileName} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full image-placeholder" />
      )}
    </div>
  )
}
