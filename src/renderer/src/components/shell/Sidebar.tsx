import { useCallback, useRef } from 'react'
import type { LibraryCounts, WatchedFolder } from '../../../../shared/types'
import { Icon, type IconName } from './icons'

export type KindFilter = 'all' | 'image' | 'video' | 'audio'

/** 侧边栏选中的"来源"：资料库某一类 / 某个文件夹 / 地图 / 人物；similar 由右键"查找相似内容"进入，不在侧栏里 */
export type Source =
  | { type: 'library'; kind: KindFilter }
  | { type: 'folder'; id: number }
  | { type: 'map' }
  | { type: 'people' }
  | { type: 'similar'; photoId: number; name: string }

export const LIBRARY_ITEMS: { kind: KindFilter; label: string; icon: IconName; shortcut: string }[] = [
  { kind: 'all', label: '全部', icon: 'all', shortcut: '⌘1' },
  { kind: 'image', label: '图片', icon: 'image', shortcut: '⌘2' },
  { kind: 'video', label: '视频', icon: 'video', shortcut: '⌘3' },
  { kind: 'audio', label: '音频', icon: 'audio', shortcut: '⌘4' },
]

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 320

interface SidebarProps {
  width: number
  onResize: (width: number) => void
  source: Source
  onSelect: (source: Source) => void
  counts: LibraryCounts | null
  folders: WatchedFolder[]
  onAddFolder: () => void
  /** "搜索"分组：已保存在前，最近在后（已保存的不重复列出） */
  savedSearches: string[]
  recentSearches: string[]
  /** 当前生效的查询，用来高亮对应的行 */
  activeQuery: string | null
  onRunSearch: (query: string) => void
  onRemoveSearch: (query: string, kind: 'saved' | 'recent') => void
}

/** 侧栏里最近搜索最多列几条，其余留在存储里 */
const RECENT_SHOWN = 5

export function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function Sidebar({
  width, onResize, source, onSelect, counts, folders, onAddFolder,
  savedSearches, recentSearches, activeQuery, onRunSearch, onRemoveSearch,
}: SidebarProps): JSX.Element {
  const dragStart = useRef<{ x: number; w: number } | null>(null)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStart.current = { x: e.clientX, w: width }
    const move = (ev: MouseEvent): void => {
      if (!dragStart.current) return
      const next = dragStart.current.w + ev.clientX - dragStart.current.x
      onResize(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)))
    }
    const up = (): void => {
      dragStart.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
  }, [width, onResize])

  const recentShown = recentSearches.filter((q) => !savedSearches.includes(q)).slice(0, RECENT_SHOWN)

  return (
    <aside style={{ width }} className="relative flex-shrink-0 h-full flex flex-col bg-sidebar border-r border-line select-none">
      {/* 红绿灯区：整条可拖动窗口 */}
      <div className="titlebar h-[52px] flex-shrink-0" />

      <nav className="flex-1 overflow-y-auto px-2.5 pb-4 flex flex-col gap-4">
        <Group title="资料库">
          {LIBRARY_ITEMS.map(({ kind, label, icon, shortcut }) => (
            <Row
              key={kind}
              icon={icon}
              label={label}
              count={counts?.[kind]}
              hint={shortcut}
              active={source.type === 'library' && source.kind === kind}
              onClick={() => onSelect({ type: 'library', kind })}
            />
          ))}
        </Group>

        <Group title="浏览">
          <Row icon="map" label="地图" hint="⌘5" active={source.type === 'map'} onClick={() => onSelect({ type: 'map' })} />
          <Row icon="people" label="人物" hint="⌘6" active={source.type === 'people'} onClick={() => onSelect({ type: 'people' })} />
        </Group>

        {(savedSearches.length > 0 || recentShown.length > 0) && (
          <Group title="搜索">
            {savedSearches.map((q) => (
              <Row
                key={`s:${q}`}
                icon="star"
                label={q}
                active={activeQuery === q}
                onClick={() => onRunSearch(q)}
                onRemove={() => onRemoveSearch(q, 'saved')}
                removeTitle="取消保存"
              />
            ))}
            {recentShown.map((q) => (
              <Row
                key={`r:${q}`}
                icon="clock"
                label={q}
                muted
                active={activeQuery === q}
                onClick={() => onRunSearch(q)}
                onRemove={() => onRemoveSearch(q, 'recent')}
                removeTitle="从最近搜索中移除"
              />
            ))}
          </Group>
        )}

        <Group
          title="文件夹"
          action={
            <button
              onClick={onAddFolder}
              title="添加文件夹 (⌘O)"
              className="w-5 h-5 rounded flex items-center justify-center text-ink-3 hover:text-ink hover:bg-fill-hover transition-colors duration-fast"
            >
              <Icon name="plus" className="w-3.5 h-3.5" />
            </button>
          }
        >
          {folders.length === 0 ? (
            <p className="px-2 py-1 text-caption text-ink-4">还没有文件夹</p>
          ) : (
            folders.map((f) => (
              <Row
                key={f.id}
                icon="folder"
                label={folderName(f.path)}
                title={f.path}
                count={f.photoCount}
                active={source.type === 'folder' && source.id === f.id}
                onClick={() => onSelect({ type: 'folder', id: f.id })}
              />
            ))
          )}
        </Group>
      </nav>

      {/* 拖动改宽度 */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 -right-1 w-2 h-full cursor-col-resize z-10"
      />
    </aside>
  )
}

function Group({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-px">
      <div className="h-6 px-2 flex items-center justify-between">
        <h3 className="text-micro font-medium text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

interface RowProps {
  icon: IconName
  label: string
  active: boolean
  onClick: () => void
  count?: number
  hint?: string
  title?: string
  /** 次要条目（最近搜索）：未激活时文字更淡 */
  muted?: boolean
  /** 悬停时右侧出现 ×；计数让位 */
  onRemove?: () => void
  removeTitle?: string
}

function Row({ icon, label, active, onClick, count, hint, title, muted, onRemove, removeTitle }: RowProps): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onClick}
      title={title ?? (hint ? `${label} (${hint})` : label)}
      className={`group/row h-7 px-2 rounded-md flex items-center gap-2 text-body text-left cursor-default transition-colors duration-fast ${
        active ? 'bg-accent-fill text-ink' : `${muted ? 'text-ink-3' : 'text-ink-2'} hover:bg-fill hover:text-ink`
      }`}
    >
      <Icon name={icon} className={`w-4 h-4 flex-shrink-0 ${active ? 'text-accent' : 'text-ink-3'}`} />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-caption text-ink-4 tabular-nums">{count.toLocaleString()}</span>
      )}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          title={removeTitle}
          data-remove
          className="w-4 h-4 -mr-0.5 rounded flex items-center justify-center text-ink-3 hover:text-ink hover:bg-fill-hover opacity-0 group-hover/row:opacity-100 transition-opacity duration-fast"
        >
          <Icon name="close" className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}
