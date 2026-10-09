import { useEffect, useState, useCallback, useRef } from 'react'
import type { Person, PersonFace, PersonSuggestion, Photo, SearchResult } from '../../../shared/types'
import { faceUrl, thumbUrl } from '../lib/mediaUrl'

interface PeopleViewProps {
  onSelectPhoto: (photo: Photo) => void
}

const DRAG_TYPE = 'application/x-vixel-person'

/** 大列表分批渲染：先挂一批，滚到哨兵附近再追加，避免一次创建几百个节点 */
function useIncremental(total: number, chunk = 120): { count: number; sentinelRef: (el: HTMLElement | null) => void } {
  const [count, setCount] = useState(chunk)
  useEffect(() => setCount(chunk), [total, chunk])
  const observer = useRef<IntersectionObserver | null>(null)
  const sentinelRef = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    observer.current = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setCount((n) => n + chunk)
    }, { rootMargin: '600px' })
    observer.current.observe(el)
  }, [chunk])
  useEffect(() => () => observer.current?.disconnect(), [])
  return { count, sentinelRef }
}

/** 合并时保留谁：已命名 > 脸多的 */
function pickTarget(group: Person[]): Person {
  return [...group].sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0) || b.faceCount - a.faceCount)[0]
}

export function PeopleView({ onSelectPhoto }: PeopleViewProps): JSX.Element {
  const [people, setPeople] = useState<Person[]>([])
  const [suggestions, setSuggestions] = useState<PersonSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState('')
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showHidden, setShowHidden] = useState(false)
  const [notice, setNotice] = useState('')

  const loadPeople = useCallback(async () => {
    const [list, sugg] = await Promise.all([window.api.getPeople(), window.api.getPersonSuggestions()])
    setPeople(list)
    setSuggestions(sugg)
    setLoading(false)
    // 子视图里的人物可能被改名 / 合并走了
    setSelectedPerson((cur) => (cur ? list.find((p) => p.id === cur.id) ?? null : null))
  }, [])

  useEffect(() => {
    loadPeople()
    // 后台聚类改动了人物：稍微合并一下刷新；人物开始出现即收起扫描横幅
    let t: ReturnType<typeof setTimeout> | null = null
    const off = window.api.onPeopleChanged(() => {
      setScanning(false)
      if (t) clearTimeout(t)
      t = setTimeout(loadPeople, 500)
    })
    return () => { off(); if (t) clearTimeout(t) }
  }, [loadPeople])

  // 扫描横幅事件驱动：索引队列回到空闲说明人脸任务都跑完了
  useEffect(() => {
    if (!scanning) return
    return window.api.onIndexProgress((p) => {
      if (p.stage === 'idle') setScanning(false)
    })
  }, [scanning])

  const flashTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(flashTimer.current), [])
  const flash = (msg: string): void => {
    setNotice(msg)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setNotice((m) => (m === msg ? '' : m)), 2500)
  }

  const handleStartScan = async (): Promise<void> => {
    setScanning(true)
    setScanProgress('正在初始化模型...')
    try {
      const result = await window.api.startFaceScan()
      if (result.error) {
        setScanProgress(`扫描失败: ${result.error}`)
        setScanning(false)
        return
      }
      setScanProgress(`已入队 ${result.queued} 张图片，识别出的人物会陆续出现`)
    } catch (e) {
      setScanProgress(`扫描失败: ${e}`)
      setScanning(false)
    }
  }

  const mergeGroup = async (group: Person[], into?: Person): Promise<void> => {
    if (group.length < 2) return
    const target = into ?? pickTarget(group)
    const sources = group.filter((p) => p.id !== target.id).map((p) => p.id)
    await window.api.mergePeople(target.id, sources)
    setSelectedIds(new Set())
    flash(`已合并 ${group.length} 个人物${target.name ? `到「${target.name}」` : ''}`)
    loadPeople()
  }

  const handleRename = async (personId: number, name: string): Promise<void> => {
    await window.api.setPersonName(personId, name.trim())
    loadPeople()
  }

  const handleHide = async (ids: number[], hidden: boolean): Promise<void> => {
    await Promise.all(ids.map((id) => window.api.setPersonHidden(id, hidden)))
    setSelectedIds(new Set())
    flash(hidden ? `已隐藏 ${ids.length} 个人物` : '已取消隐藏')
    loadPeople()
  }

  const toggleSelect = (id: number): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ── 人物详情 ──
  if (selectedPerson) {
    return (
      <PersonDetail
        person={selectedPerson}
        others={people.filter((p) => p.id !== selectedPerson.id && !p.hidden)}
        onBack={() => setSelectedPerson(null)}
        onSelectPhoto={onSelectPhoto}
        onRename={(name) => handleRename(selectedPerson.id, name)}
        onHide={async (hidden) => {
          await handleHide([selectedPerson.id], hidden)
          if (hidden) setSelectedPerson(null)
        }}
        onChanged={loadPeople}
      />
    )
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-canvas">
        <p className="text-ink-3 text-callout">加载中...</p>
      </div>
    )
  }

  const visible = people.filter((p) => !p.hidden)
  const hidden = people.filter((p) => p.hidden)
  const shown = showHidden ? hidden : visible
  const selected = people.filter((p) => selectedIds.has(p.id))

  // 空状态
  if (people.length === 0 && !scanning) {
    return (
      <div className="h-full flex items-center justify-center bg-canvas">
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

  return (
    <div className="relative h-full flex flex-col bg-canvas">
      {scanning && (
        <div className="px-4 py-2 bg-accent/10 text-accent text-callout flex items-center gap-2">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {scanProgress}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4" onClick={() => setSelectedIds(new Set())}>
        {!showHidden && suggestions.length > 0 && (
          <SuggestionCard
            suggestion={suggestions[0]}
            remaining={suggestions.length}
            onSame={async (s) => { await mergeGroup([s.a, s.b], s.a.name ? s.a : undefined) }}
            onDifferent={async (s) => { await window.api.dismissPersonSuggestion(s.a.id, s.b.id); loadPeople() }}
          />
        )}

        <div className="flex items-baseline gap-3 mb-3">
          <h2 className="text-headline text-ink">{showHidden ? '已隐藏的人物' : '人物'}</h2>
          <span className="text-callout text-ink-3">{shown.length}</span>
          <span className="flex-1" />
          {!showHidden && (
            <span className="text-micro text-ink-3">双击名字命名 · ⌘ 点击多选 · 拖到另一人上合并</span>
          )}
          {(hidden.length > 0 || showHidden) && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowHidden((v) => !v); setSelectedIds(new Set()) }}
              className="text-callout text-ink-3 hover:text-ink"
            >
              {showHidden ? '← 返回人物' : `已隐藏 (${hidden.length})`}
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-4">
          {shown.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              selected={selectedIds.has(person.id)}
              onOpen={() => setSelectedPerson(person)}
              onToggleSelect={() => toggleSelect(person.id)}
              onRename={(name) => handleRename(person.id, name)}
              onDropPeople={(ids) => {
                const group = people.filter((p) => ids.includes(p.id) || p.id === person.id)
                // 拖到已命名的人上：保留目标；否则按默认规则
                mergeGroup(group, person.name ? person : undefined)
              }}
              dragIds={() => (selectedIds.has(person.id) ? [...selectedIds] : [person.id])}
            />
          ))}
        </div>

        {!scanning && !showHidden && (
          <div className="text-center mt-6">
            <button onClick={handleStartScan} className="text-micro text-ink-3 hover:text-ink-2">
              扫描新照片中的人脸
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-raised border border-line text-callout text-ink shadow-lg animate-fade-in">
          {notice}
        </div>
      )}

      {selected.length > 0 && (
        <div className="px-4 py-2.5 border-t border-line bg-bar flex items-center gap-2 animate-fade-in">
          <span className="text-callout text-ink-2">已选 {selected.length} 个人物</span>
          <span className="flex-1" />
          <button onClick={() => setSelectedIds(new Set())} className="px-3 py-1.5 text-callout text-ink-3 hover:text-ink">
            取消
          </button>
          <button
            onClick={() => handleHide(selected.map((p) => p.id), !showHidden)}
            className="px-3 py-1.5 rounded-md bg-fill hover:bg-fill-hover text-callout text-ink-2"
          >
            {showHidden ? '取消隐藏' : '隐藏'}
          </button>
          {selected.length >= 2 && (
            <button
              onClick={() => mergeGroup(selected)}
              className="px-3 py-1.5 rounded-md bg-accent/20 hover:bg-accent/30 text-accent text-callout"
            >
              合并为同一人
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function FaceCircle({ faceId, className = '' }: { faceId: number | null | undefined; className?: string }): JSX.Element {
  // 人脸裁剪由主进程落盘缓存、经 vixel://face 协议直出（faceId 不复用，无需缓存参数）
  const [error, setError] = useState(false)
  useEffect(() => setError(false), [faceId])
  return (
    <div className={`rounded-full overflow-hidden bg-surface-3 ${className}`}>
      {faceId && !error ? (
        <img
          src={faceUrl(faceId)}
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setError(true)}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-ink-ghost">
          <svg className="w-1/3 h-1/3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
      )}
    </div>
  )
}

/** 名字：双击（或点"添加名字"）进入编辑，回车 / 失焦保存，Esc 取消 */
function EditableName({ name, onSave, className = '' }: { name: string | null; onSave: (name: string) => void; className?: string }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const done = useRef(false)
  const start = (e: React.MouseEvent): void => {
    e.stopPropagation()
    done.current = false
    setValue(name ?? '')
    setEditing(true)
  }
  const commit = (save: boolean): void => {
    if (done.current) return
    done.current = true
    setEditing(false)
    if (save && value.trim() !== (name ?? '')) onSave(value)
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        placeholder="输入名字"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(true)
          if (e.key === 'Escape') commit(false)
        }}
        onBlur={() => commit(true)}
        onClick={(e) => e.stopPropagation()}
        className={`w-full text-center bg-fill border border-line-heavy rounded px-1 py-0.5 text-ink focus:outline-none ${className}`}
      />
    )
  }
  return name ? (
    <p className={`text-center text-ink-2 truncate cursor-text ${className}`} onDoubleClick={start} title="双击修改名字">
      {name}
    </p>
  ) : (
    <p className={`text-center text-ink-4 hover:text-accent truncate cursor-pointer ${className}`} onClick={start}>
      添加名字
    </p>
  )
}

interface PersonCardProps {
  person: Person
  selected: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onRename: (name: string) => void
  onDropPeople: (ids: number[]) => void
  dragIds: () => number[]
}

function PersonCard({ person, selected, onOpen, onToggleSelect, onRename, onDropPeople, dragIds }: PersonCardProps): JSX.Element {
  const [dropping, setDropping] = useState(false)
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragIds()))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]') as number[]
        if (ids.length && !(ids.length === 1 && ids[0] === person.id)) {
          e.preventDefault()
          onDropPeople(ids.filter((id) => id !== person.id))
        }
      }}
      onClick={(e) => {
        e.stopPropagation()
        if (e.metaKey || e.shiftKey || e.ctrlKey) onToggleSelect()
        else onOpen()
      }}
      className="cursor-pointer group relative"
      data-person-id={person.id}
    >
      <div
        onClick={(e) => { e.stopPropagation(); onToggleSelect() }}
        className={`absolute top-1 left-1 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
          selected ? 'bg-accent border-accent' : 'border-line-heavy bg-canvas/60 opacity-0 group-hover:opacity-100'
        }`}
      >
        {selected && (
          <svg className="w-3 h-3 text-black/85" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      <FaceCircle
        faceId={person.coverFaceId}
        className={`w-full aspect-square mb-2 transition-all duration-fast ${
          dropping ? 'ring-4 ring-accent scale-105' : selected ? 'ring-2 ring-accent' : 'group-hover:brightness-110'
        }`}
      />
      <EditableName name={person.name} onSave={onRename} className="text-callout" />
      <p className="text-center text-micro text-ink-3 mt-0.5">{person.photoCount} 张图片</p>
    </div>
  )
}

interface SuggestionCardProps {
  suggestion: PersonSuggestion
  remaining: number
  onSame: (s: PersonSuggestion) => Promise<void>
  onDifferent: (s: PersonSuggestion) => Promise<void>
}

function SuggestionCard({ suggestion: s, remaining, onSame, onDifferent }: SuggestionCardProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const act = (fn: (s: PersonSuggestion) => Promise<void>) => async (e: React.MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    try { await fn(s) } finally { setBusy(false) }
  }
  const label = (p: Person): string => p.name || `${p.photoCount ?? p.faceCount} 张图片`
  return (
    <div
      className="mb-5 p-3 rounded-lg border border-line bg-surface-1 flex items-center gap-4"
      onClick={(e) => e.stopPropagation()}
      data-testid="person-suggestion"
    >
      <div className="flex items-center -space-x-3">
        <FaceCircle faceId={s.a.coverFaceId} className="w-14 h-14 ring-2 ring-surface-1" />
        <FaceCircle faceId={s.b.coverFaceId} className="w-14 h-14 ring-2 ring-surface-1" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-body text-ink">是同一个人吗？</p>
        <p className="text-callout text-ink-3 truncate">
          {s.a.name ? `这位是「${s.a.name}」吗？` : `${label(s.a)} · ${label(s.b)}`}
          {remaining > 1 && <span className="text-ink-4"> · 还有 {remaining - 1} 组</span>}
        </p>
      </div>
      <button
        disabled={busy}
        onClick={act(onDifferent)}
        className="px-3 py-1.5 rounded-md bg-fill hover:bg-fill-hover text-callout text-ink-2 disabled:opacity-50"
      >
        不是
      </button>
      <button
        disabled={busy}
        onClick={act(onSame)}
        className="px-3 py-1.5 rounded-md bg-accent/20 hover:bg-accent/30 text-accent text-callout disabled:opacity-50"
      >
        是同一人
      </button>
    </div>
  )
}

interface PersonDetailProps {
  person: Person
  others: Person[]
  onBack: () => void
  onSelectPhoto: (photo: Photo) => void
  onRename: (name: string) => void
  onHide: (hidden: boolean) => void
  onChanged: () => void
}

function PersonDetail({ person, others, onBack, onSelectPhoto, onRename, onHide, onChanged }: PersonDetailProps): JSX.Element {
  const [tab, setTab] = useState<'photos' | 'faces'>('photos')
  const [photos, setPhotos] = useState<SearchResult[]>([])
  const [faces, setFaces] = useState<PersonFace[]>([])
  const [moving, setMoving] = useState<number | null>(null)

  const load = useCallback(async () => {
    const [ph, fs] = await Promise.all([
      window.api.getPersonPhotos(person.id, 500),
      window.api.getPersonFaces(person.id, 500),
    ])
    setPhotos(ph)
    setFaces(fs)
  }, [person.id])

  useEffect(() => { load() }, [load, person.faceCount])

  const photosInc = useIncremental(photos.length)
  const facesInc = useIncremental(faces.length)

  const reject = async (faceId: number): Promise<void> => {
    setFaces((fs) => fs.filter((f) => f.id !== faceId))
    await window.api.rejectFace(faceId)
    onChanged()
  }
  const moveTo = async (faceId: number, personId: number): Promise<void> => {
    setMoving(null)
    setFaces((fs) => fs.filter((f) => f.id !== faceId))
    await window.api.assignFace(faceId, personId)
    onChanged()
  }

  return (
    <div className="h-full flex flex-col bg-canvas">
      <div className="px-4 py-3 flex items-center gap-3 border-b border-line">
        <button onClick={onBack} className="p-1 rounded hover:bg-fill-hover text-ink-2" title="返回">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <FaceCircle faceId={person.coverFaceId} className="w-8 h-8" />
        <div className="min-w-[8rem] max-w-[16rem]">
          <EditableName name={person.name} onSave={onRename} className="text-body font-medium !text-left" />
        </div>
        <span className="text-callout text-ink-3">{person.photoCount} 张图片</span>
        <span className="flex-1" />
        <div className="flex rounded-md bg-fill p-0.5 text-callout">
          {(['photos', 'faces'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 rounded ${tab === t ? 'bg-fill-active text-ink' : 'text-ink-3 hover:text-ink-2'}`}
            >
              {t === 'photos' ? '照片' : `人脸 ${faces.length}`}
            </button>
          ))}
        </div>
        <button
          onClick={() => onHide(!person.hidden)}
          className="px-2.5 py-1 rounded-md text-callout text-ink-3 hover:text-ink hover:bg-fill-hover"
        >
          {person.hidden ? '取消隐藏' : '隐藏此人'}
        </button>
      </div>

      {tab === 'photos' ? (
        <div className="flex-1 overflow-auto p-0.5">
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-0.5">
            {photos.slice(0, photosInc.count).map((r) => (
              <PhotoThumb key={r.photo.id} photo={r.photo} onClick={() => onSelectPhoto(r.photo)} />
            ))}
          </div>
          {photos.length > photosInc.count && <div ref={photosInc.sentinelRef} className="h-8" />}
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <p className="text-callout text-ink-3 mb-3">认错的脸点「不是此人」，以后也不会再自动归到这里；也可以直接移给另一个人。</p>
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-3">
            {faces.slice(0, facesInc.count).map((f) => (
              <div key={f.id} className="group relative" data-face-id={f.id}>
                <FaceCircle faceId={f.id} className={`w-full aspect-square ${f.quality < 0.4 ? 'opacity-70' : ''}`} />
                <div className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => reject(f.id)}
                    className="w-full py-0.5 rounded bg-black/70 text-micro text-white hover:bg-bad/90"
                  >
                    不是此人
                  </button>
                  {others.length > 0 && (
                    <button
                      onClick={() => setMoving(moving === f.id ? null : f.id)}
                      className="w-full py-0.5 rounded bg-black/70 text-micro text-white hover:bg-black/85"
                    >
                      移给…
                    </button>
                  )}
                </div>
                {moving === f.id && (
                  <div className="absolute z-20 top-full left-0 mt-1 w-44 max-h-60 overflow-auto rounded-md border border-line bg-raised shadow-lg py-1">
                    {others.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => moveTo(f.id, p.id)}
                        className="w-full flex items-center gap-2 px-2 py-1 text-left text-callout text-ink-2 hover:bg-fill-hover"
                      >
                        <FaceCircle faceId={p.coverFaceId} className="w-5 h-5 shrink-0" />
                        <span className="truncate">{p.name || `未命名 · ${p.photoCount} 张`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {faces.length > facesInc.count && <div ref={facesInc.sentinelRef} className="h-8" />}
        </div>
      )}
    </div>
  )
}

/** 简单的照片缩略图（复用于人物详情）：直接走 vixel://thumb 协议 + 懒加载 */
function PhotoThumb({ photo, onClick }: { photo: Photo; onClick: () => void }): JSX.Element {
  return (
    <div
      className="aspect-square overflow-hidden cursor-pointer bg-surface-2 hover:brightness-110"
      onClick={onClick}
    >
      <img
        src={thumbUrl(photo)}
        alt={photo.fileName}
        className="w-full h-full object-cover"
        loading="lazy"
        decoding="async"
      />
    </div>
  )
}
