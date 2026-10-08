import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../shell/icons'
import { ModelStatus } from '../ModelStatus'
import { GeneralSettings } from './GeneralSettings'
import { FolderSettings } from './FolderSettings'

type Tab = 'general' | 'folders' | 'model'

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'general', label: '通用', icon: 'gear' },
  { id: 'folders', label: '文件夹', icon: 'folder' },
  { id: 'model', label: 'AI 模型', icon: 'sparkles' },
]

const TAB_KEY = 'settings.tab'

function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    if (v === 'general' || v === 'folders' || v === 'model') return v
  } catch { /* ignore */ }
  return 'general'
}

/**
 * 独立设置窗口（⌘,）：macOS 偏好设置式的顶部图标标签栏，窗口标题跟随标签。
 * 和主窗口同一个渲染入口，main.tsx 按 #settings 路由过来。
 */
export function SettingsWindow(): JSX.Element {
  const [tab, setTab] = useState<Tab>(loadTab)
  const current = TABS.find((t) => t.id === tab)!

  useEffect(() => {
    document.title = current.label
    try { localStorage.setItem(TAB_KEY, tab) } catch { /* ignore */ }
  }, [tab, current.label])

  return (
    <div className="h-screen flex flex-col bg-raised text-ink select-none">
      <header className="titlebar flex-shrink-0 bg-bar border-b border-line flex flex-col items-center pt-1.5 pb-1.5">
        <h1 className="text-callout font-semibold text-ink-2 h-[22px] leading-[22px]">{current.label}</h1>
        <nav className="flex gap-1">
          {TABS.map((t) => {
            const active = t.id === tab
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`w-[68px] h-[46px] rounded-md flex flex-col items-center justify-center gap-0.5 transition-colors duration-fast ${
                  active ? 'bg-fill-active text-accent' : 'text-ink-3 hover:text-ink-2 hover:bg-fill'
                }`}
              >
                <Icon name={t.icon} className="w-5 h-5" />
                <span className={`text-caption ${active ? 'text-ink' : ''}`}>{t.label}</span>
              </button>
            )
          })}
        </nav>
      </header>
      <main className="flex-1 min-h-0 overflow-auto">
        {tab === 'general' && <GeneralSettings />}
        {tab === 'folders' && <FolderSettings />}
        {tab === 'model' && <ModelStatus />}
      </main>
    </div>
  )
}
