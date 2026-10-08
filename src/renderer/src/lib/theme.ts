import { useEffect, useState } from 'react'

const query = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

/**
 * 当前生效的外观（深 / 浅）。主进程 nativeTheme.themeSource 决定 prefers-color-scheme，
 * CSS 变量自动跟随；只有 CSS 管不到的地方（地图瓦片）才需要这个 hook。
 */
export function useColorScheme(): 'dark' | 'light' {
  const [dark, setDark] = useState(() => query().matches)
  useEffect(() => {
    const mq = query()
    const onChange = (): void => setDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark ? 'dark' : 'light'
}
