import { SearchBar } from '../SearchBar'
import { Icon } from './icons'

interface ToolbarProps {
  title: string
  subtitle?: string
  /** 侧边栏收起时要给红绿灯让位 */
  sidebarHidden: boolean
  onToggleSidebar: () => void
  /** 地图 / 人物视图不显示搜索与过滤 */
  showSearch: boolean
  onSearch: (query: string) => void
  isSearching: boolean
  resultCount?: number
  dateActive: boolean
  onToggleDate: () => void
  onOpenSettings: () => void
}

export function Toolbar({
  title, subtitle, sidebarHidden, onToggleSidebar, showSearch, onSearch, isSearching, resultCount,
  dateActive, onToggleDate, onOpenSettings,
}: ToolbarProps): JSX.Element {
  return (
    <header className={`titlebar h-[52px] flex-shrink-0 flex items-center gap-3 pr-3 bg-bar border-b border-line ${sidebarHidden ? 'pl-[84px]' : 'pl-4'}`}>
      {sidebarHidden && (
        <ToolButton icon="sidebar" title="显示侧边栏 (⌥⌘S)" onClick={onToggleSidebar} />
      )}

      <div className="min-w-0 flex flex-col justify-center">
        <h1 className="text-headline text-ink truncate">{title}</h1>
        {subtitle && <p className="text-caption text-ink-3 truncate tabular-nums">{subtitle}</p>}
      </div>

      <div className="flex-1" />

      {showSearch && (
        <div className="w-[clamp(240px,32vw,480px)]">
          <SearchBar onSearch={onSearch} isSearching={isSearching} resultCount={resultCount} />
        </div>
      )}

      <div className="flex items-center gap-0.5">
        {showSearch && (
          <ToolButton icon="calendar" title="时间过滤" active={dateActive} onClick={onToggleDate} />
        )}
        <ToolButton icon="gear" title="设置 (⌘,)" onClick={onOpenSettings} />
      </div>
    </header>
  )
}

function ToolButton({ icon, title, onClick, active }: {
  icon: Parameters<typeof Icon>[0]['name']
  title: string
  onClick: () => void
  active?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors duration-fast ${
        active ? 'bg-accent-fill text-accent' : 'text-ink-3 hover:text-ink hover:bg-fill-hover'
      }`}
    >
      <Icon name={icon} />
    </button>
  )
}
