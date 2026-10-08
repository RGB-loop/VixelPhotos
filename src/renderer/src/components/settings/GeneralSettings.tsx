import { useEffect, useState } from 'react'
import type { ThemeMode } from '../../../../shared/types'

/** 外观选项的迷你窗口示意：侧栏 + 内容区两块，颜色写死（预览的就是另一种外观） */
const SWATCH = {
  light: { sidebar: '#f1efec', canvas: '#ffffff', ink: 'rgb(0 0 0 / 0.18)' },
  dark: { sidebar: '#171615', canvas: '#0f0f0f', ink: 'rgb(255 255 255 / 0.22)' },
} as const

const OPTIONS: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: '跟随系统' },
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
]

/** 设置 › 通用：外观 */
export function GeneralSettings(): JSX.Element {
  const [theme, setTheme] = useState<ThemeMode | null>(null)

  useEffect(() => {
    window.api.getTheme().then(setTheme)
  }, [])

  const choose = (mode: ThemeMode): void => {
    setTheme(mode)
    window.api.setTheme(mode).then(setTheme)
  }

  return (
    <div className="p-6 flex flex-col gap-6">
      <section className="flex gap-6">
        <h3 className="w-24 flex-shrink-0 text-right text-body text-ink-2 pt-1">外观</h3>
        <div className="flex flex-col gap-2">
          <div className="flex gap-4">
            {OPTIONS.map(({ mode, label }) => {
              const active = theme === mode
              return (
                <button key={mode} onClick={() => choose(mode)} className="flex flex-col items-center gap-1.5 group">
                  <span
                    className={`block w-[88px] h-[58px] rounded-md overflow-hidden transition-shadow duration-fast ${
                      active ? 'ring-2 ring-accent ring-offset-2 ring-offset-raised' : 'ring-1 ring-line-strong group-hover:ring-line-heavy'
                    }`}
                  >
                    {mode === 'system' ? (
                      <span className="relative block w-full h-full">
                        <Swatch scheme="light" />
                        <span className="absolute inset-0" style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}>
                          <Swatch scheme="dark" />
                        </span>
                      </span>
                    ) : (
                      <Swatch scheme={mode} />
                    )}
                  </span>
                  <span className={`text-callout ${active ? 'text-ink' : 'text-ink-2'}`}>{label}</span>
                </button>
              )
            })}
          </div>
          <p className="text-caption text-ink-4">大图详情和快速查看始终使用深色背景，便于看片。</p>
        </div>
      </section>
    </div>
  )
}

function Swatch({ scheme }: { scheme: 'light' | 'dark' }): JSX.Element {
  const c = SWATCH[scheme]
  return (
    <span className="flex w-full h-full" style={{ background: c.canvas }}>
      <span className="w-[26px] h-full flex flex-col gap-[3px] p-[5px] pt-[12px]" style={{ background: c.sidebar }}>
        <span className="h-[3px] rounded-full" style={{ background: c.ink }} />
        <span className="h-[3px] w-3/4 rounded-full" style={{ background: c.ink }} />
        <span className="h-[3px] w-2/3 rounded-full" style={{ background: c.ink }} />
      </span>
      <span className="flex-1 grid grid-cols-3 gap-[3px] p-[5px] pt-[12px] content-start">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="aspect-square rounded-[2px]" style={{ background: i === 1 ? '#d4a574' : c.ink }} />
        ))}
      </span>
    </span>
  )
}
