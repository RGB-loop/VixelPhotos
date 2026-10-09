import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsWindow } from './components/settings/SettingsWindow'
import './styles/globals.css'

// 设置窗口和主窗口共用这一个入口，主进程用 #settings 区分
const isSettings = window.location.hash === '#settings'

// 开发期（或 localStorage 设 vixel.profile=1）观测渲染进程长任务，>50ms 直接 console.warn
try {
  if (import.meta.env.DEV || localStorage.getItem('vixel.profile') === '1') {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) console.warn(`[longtask] ${Math.round(entry.duration)}ms @ ${(entry.startTime / 1000).toFixed(1)}s`)
      }
    }).observe({ entryTypes: ['longtask'] })
  }
} catch { /* 环境不支持就算了 */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isSettings ? <SettingsWindow /> : <App />}
  </React.StrictMode>
)
