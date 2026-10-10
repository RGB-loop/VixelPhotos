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

const QUERIES = (process.env.VIXEL_CAPTURE_QUERIES || '西瓜,微信支付,海边').split(',')

const STEPS: Step[] = [
  { name: 'all', run: command('source:all'), wait: 2500 },
  // 查询可用环境变量覆盖（逗号分隔：语义查询, 图中文字查询, 库里没有的东西）
  { name: 'search', run: js(typeSearch(QUERIES[0])), wait: 3000 },
  { name: 'inspector', run: js(`document.querySelector('.photo-card')?.click()`), wait: 2000 },
  { name: 'detail', run: js(`document.querySelector('.photo-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`), wait: 2000 },
  { name: 'video', run: (w) => { js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(w); command('source:video')(w) }, wait: 2000 },
  { name: 'search-text', run: (w) => { command('source:all')(w); js(typeSearch(QUERIES[1]))(w) }, wait: 3000 },
  { name: 'search-nomatch', run: js(typeSearch(QUERIES[2])), wait: 3000 },
  { name: 'people', run: (w) => { js(typeSearch(''))(w); command('source:people')(w) }, wait: 6000 },
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

// ─── 录屏：VIXEL_RECORD=<out.mp4> ───────────────────────────────────────────
//
// 按脚本演示一遍真实界面，用 webContents 的帧订阅录成 1080p 视频（窗口 1280×720 × 1.5 倍缩放），
// 同时把每个场景的起止时间写到 <out>.timeline.json，供 scripts/make-promo.mjs 加字幕和片头片尾。
// 不需要系统录屏权限，也不会录到鼠标指针以外的任何桌面内容。

interface Scene { name: string; caption: string; run: (win: BrowserWindow) => Promise<void> }

/** 逐字输入（触发搜索框自己的防抖），模拟真人打字 */
const typeSlowly = async (win: BrowserWindow, text: string): Promise<void> => {
  await js(typeSearch(''))(win)
  for (let i = 1; i <= text.length; i++) {
    await win.webContents.executeJavaScript(`try {
      const el = document.querySelector('input[type="search"], input[placeholder^="搜索"]');
      el.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(text.slice(0, i))}); el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {}`)
    await sleep(160)
  }
}

const press = (key: string) => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`)
const openFirst = js(`document.querySelector('.photo-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
/** 打开带"图中文字"角标的那张（图中文字命中优先展示） */
const openTextHit = js(`([...document.querySelectorAll('.photo-card')].find((c) => c.textContent.includes('图中文字')) ?? document.querySelector('.photo-card'))?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
const selectFirst = js(`document.querySelector('.photo-card')?.click()`)
const scrollGrid = (top: number) => js(`(() => { const el = [...document.querySelectorAll('[role="listbox"] div')].find((d) => d.scrollHeight > d.clientHeight + 10); el?.scrollTo({ top: ${top}, behavior: 'smooth' }) })()`)

const PROMO_SCENES: Scene[] = [
  { name: 'library', caption: '照片、视频、RAW，一个地方全部找得到', run: async (w) => {
    command('source:all')(w); await sleep(1800); await scrollGrid(420)(w); await sleep(1800); await scrollGrid(0)(w); await sleep(1200)
  } },
  { name: 'semantic', caption: '用一句话描述，不用记文件名', run: async (w) => {
    await typeSlowly(w, '瀑布'); await sleep(2200); await openFirst(w); await sleep(4200); await press('Escape')(w); await sleep(600)
  } },
  { name: 'object', caption: '物体、场景、动作都能搜', run: async (w) => {
    await typeSlowly(w, '花'); await sleep(2400); await selectFirst(w); await sleep(2800); await press('Escape')(w); await sleep(400)
  } },
  { name: 'ocr', caption: '视频画面里出现过的文字，也能搜到', run: async (w) => {
    await typeSlowly(w, 'STARBUCKS'); await sleep(2400); await openTextHit(w); await sleep(3600); await press('Escape')(w); await sleep(400)
  } },
  { name: 'ocr2', caption: '截图、手写笔记、菜单上的字', run: async (w) => {
    await typeSlowly(w, 'TODO'); await sleep(2600)
  } },
  { name: 'honest', caption: '没有把握时，它会直说', run: async (w) => {
    await typeSlowly(w, '猫'); await sleep(3000)
  } },
  { name: 'dark', caption: '浅色、深色，跟随系统', run: async (w) => {
    await typeSlowly(w, ''); await js(typeSearch(''))(w); await sleep(800)
    nativeTheme.themeSource = 'dark'; await sleep(2600); nativeTheme.themeSource = 'light'; await sleep(600)
  } },
]

export async function runRecording(win: BrowserWindow, outPath: string): Promise<void> {
  const { spawn } = await import('child_process')
  const mod = (await import('ffmpeg-static')) as unknown as { default?: string } & string
  const ffmpeg = (mod.default ?? mod) as string
  const FPS = 30
  win.setContentSize(1280, 720)
  win.center()
  // 窗口被遮挡 / 失焦时 Chromium 会停止绘制，帧订阅就收不到新帧（录出来一直是同一画面）
  win.webContents.setBackgroundThrottling(false)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.focus()
  nativeTheme.themeSource = 'light'
  await sleep(6000) // 首屏数据 + 缩略图 + 模型预热

  const enc = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', '-r', String(FPS), outPath],
  { stdio: ['pipe', 'ignore', 'inherit'] })

  let latest: Buffer | null = null
  let dirty: Electron.NativeImage | null = null
  win.webContents.beginFrameSubscription(false, (image) => { dirty = image })
  const t0 = Date.now()
  let written = 0
  // 按墙钟补帧：画面不变时重复上一帧，视频时长与真实演示一致
  const tick = setInterval(() => {
    if (dirty) { latest = dirty.toJPEG(92); dirty = null }
    if (!latest) return
    const due = Math.floor(((Date.now() - t0) * FPS) / 1000)
    while (written < due) { enc.stdin.write(latest); written++ }
  }, 1000 / FPS / 2)

  const timeline: Array<{ name: string; caption: string; start: number; end: number }> = []
  for (const scene of PROMO_SCENES) {
    const start = (Date.now() - t0) / 1000
    await scene.run(win)
    timeline.push({ name: scene.name, caption: scene.caption, start, end: (Date.now() - t0) / 1000 })
    console.log(`[record] ${scene.name} ${start.toFixed(1)}s`)
  }
  await sleep(500)
  clearInterval(tick)
  win.setAlwaysOnTop(false)
  win.webContents.endFrameSubscription()
  enc.stdin.end()
  await new Promise((r) => enc.on('close', r))
  await writeFile(`${outPath}.timeline.json`, JSON.stringify(timeline, null, 2))
  console.log(`[record] ${written} frames → ${outPath}`)
  app.quit()
}
