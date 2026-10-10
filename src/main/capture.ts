/**
 * 截图巡检：VIXEL_CAPTURE=<目录> 启动时，主窗口就绪后依次切到各视图、浅色 / 深色各截一张，
 * 存成 <目录>/<theme>-<step>.png 然后退出。用于 UI 回归检查和宣发素材，不需要系统截屏权限。
 *
 *   VIXEL_CAPTURE=/tmp/shots npx electron . --user-data-dir=<库目录>
 */

import { app, type BrowserWindow, nativeTheme } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { IPC_CHANNELS, type MenuCommand } from '../shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Step { name: string; run: (win: BrowserWindow) => Promise<void> | void; wait?: number }

const command = (cmd: MenuCommand) => (win: BrowserWindow) => win.webContents.send(IPC_CHANNELS.MENU_COMMAND, cmd)

/** 在渲染进程里执行一段脚本（模拟用户输入），找不到元素就算了 */
const js = (code: string) => (win: BrowserWindow) => win.webContents.executeJavaScript(`try { ${code} } catch (e) {}`).then(() => {})

const typeSearch = (q: string): string => `
  const el = document.querySelector('input[type="search"], input[placeholder^="搜索"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`

const STEPS: Step[] = [
  { name: 'all', run: command('source:all'), wait: 2500 },
  { name: 'search', run: js(typeSearch(process.env.VIXEL_CAPTURE_QUERY || '海边')), wait: 3000 },
  { name: 'inspector', run: js(`document.querySelector('.photo-card')?.click()`), wait: 1500 },
  { name: 'detail', run: js(`document.querySelector('.photo-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`), wait: 2000 },
  { name: 'video', run: (w) => { js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(w); command('source:video')(w) }, wait: 2000 },
  { name: 'people', run: command('source:people'), wait: 2500 },
  { name: 'map', run: command('source:map'), wait: 3500 },
  { name: 'tasks', run: (w) => { command('source:all')(w); command('activity')(w) }, wait: 2000 },
]

export async function runCaptureTour(win: BrowserWindow, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  win.setSize(1440, 900)
  win.center()
  await sleep(4000) // 首屏数据 + 缩略图
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await sleep(800)
    for (const step of STEPS) {
      await step.run(win)
      await sleep(step.wait ?? 1500)
      const img = await win.webContents.capturePage()
      await writeFile(join(outDir, `${theme}-${step.name}.png`), img.toPNG())
      console.log(`[capture] ${theme}-${step.name}.png`)
    }
    // 收起抽屉 / 清空搜索，下一轮从干净状态开始
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(win)
    await js(typeSearch(''))(win)
    await sleep(800)
  }
  app.quit()
}
