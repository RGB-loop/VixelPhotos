import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsWindow } from './components/settings/SettingsWindow'
import './styles/globals.css'

// 设置窗口和主窗口共用这一个入口，主进程用 #settings 区分
const isSettings = window.location.hash === '#settings'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isSettings ? <SettingsWindow /> : <App />}
  </React.StrictMode>
)
