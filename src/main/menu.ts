import { app, Menu, shell, BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** macOS 叫访达，Windows / Linux 是文件管理器 */
const REVEAL_LABEL = process.platform === 'darwin' ? '在访达中显示' : '打开文件所在的位置'
import { IPC_CHANNELS, type ItemMenuAction, type MenuCommand } from '../shared/types'

/**
 * 原生应用菜单。设计 spec 要求：每个快捷键都能在菜单里找到，
 * 所以 ⌘ 组合键统一在这里注册，点击后把命令发给渲染进程。
 */
export function installAppMenu(
  getWindow: () => BrowserWindow | null,
  { openSettings }: { openSettings: () => void }
): void {
  // 命令只发给主窗口；设置窗口在前台时（⌘A、⌘1 之类）不去动主窗口
  const send = (cmd: MenuCommand) => (): void => {
    const win = getWindow()
    const focused = BrowserWindow.getFocusedWindow()
    if (!win || (focused && focused !== win && cmd !== 'add-folder')) return
    win.webContents.send(IPC_CHANNELS.MENU_COMMAND, cmd)
  }
  const item = (label: string, accelerator: string, cmd: MenuCommand): MenuItemConstructorOptions => ({
    label, accelerator, click: send(cmd),
  })
  // 空格 / 回车只在菜单里展示，不注册成全局加速键，否则输入框里打不了空格；渲染进程自己处理按键
  const hint = (label: string, accelerator: string, cmd: MenuCommand): MenuItemConstructorOptions => ({
    label, accelerator, registerAccelerator: false, click: send(cmd),
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${app.name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${app.name}` },
      ],
    },
    {
      label: '文件',
      submenu: [
        item('添加文件夹…', 'CmdOrCtrl+O', 'add-folder'),
        { type: 'separator' },
        hint('打开', 'Enter', 'open-item'),
        hint('快速查看', 'Space', 'quick-look'),
        item(REVEAL_LABEL, 'CmdOrCtrl+Shift+R', 'reveal'),
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      // 输入框的复制粘贴依赖这些 role，不能省
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        // 不用 selectAll role：焦点在网格时要全选项目而不是页面文字，交给渲染进程判断
        item('全选', 'CmdOrCtrl+A', 'select-all'),
        { type: 'separator' },
        item('搜索', 'CmdOrCtrl+F', 'find'),
      ],
    },
    {
      label: '显示',
      submenu: [
        item('全部', 'CmdOrCtrl+1', 'source:all'),
        item('图片', 'CmdOrCtrl+2', 'source:image'),
        item('视频', 'CmdOrCtrl+3', 'source:video'),
        item('音频', 'CmdOrCtrl+4', 'source:audio'),
        { type: 'separator' },
        item('地图', 'CmdOrCtrl+5', 'source:map'),
        item('人物', 'CmdOrCtrl+6', 'source:people'),
        { type: 'separator' },
        item('放大缩略图', 'CmdOrCtrl+Plus', 'zoom-in'),
        item('缩小缩略图', 'CmdOrCtrl+-', 'zoom-out'),
        hint('切换信息密度', 'G', 'toggle-density'),
        { type: 'separator' },
        item('显示/隐藏侧边栏', 'CmdOrCtrl+Alt+S', 'toggle-sidebar'),
        item('显示/隐藏检查器', 'CmdOrCtrl+I', 'toggle-inspector'),
        item('活动', 'CmdOrCtrl+Alt+A', 'activity'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: '窗口',
      role: 'windowMenu',
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        { label: 'Vixel 主页', click: () => { shell.openExternal('https://github.com/vixel-app/vixel#readme') } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 网格项右键菜单：动作由渲染进程执行（它知道选中了哪些项），这里只负责弹出并回传选择 */
export function popupItemMenu(
  win: BrowserWindow,
  { count, isMedia }: { count: number; isMedia: boolean }
): Promise<ItemMenuAction | null> {
  return new Promise((resolve) => {
    const pick = (action: ItemMenuAction) => (): void => resolve(action)
    const multi = count > 1
    const template: MenuItemConstructorOptions[] = [
      ...(multi ? [] : [
        { label: '打开', click: pick('open') },
        { label: '快速查看', click: pick('quick-look') },
        { type: 'separator' },
      ] as MenuItemConstructorOptions[]),
      { label: multi ? `${REVEAL_LABEL} ${count} 项` : REVEAL_LABEL, accelerator: 'CmdOrCtrl+Shift+R', click: pick('reveal') },
      { label: multi ? `拷贝 ${count} 个路径` : '拷贝路径', click: pick('copy-path') },
      ...(multi ? [] : [
        { type: 'separator' },
        { label: '查找相似内容', click: pick('find-similar') },
        ...(isMedia ? [{ label: '在系统播放器中打开', click: pick('open-external') }] : []),
      ] as MenuItemConstructorOptions[]),
    ]
    // macOS 上 click 可能晚于关闭回调到达：关闭后稍等再按"未选择"收尾，Promise 只认第一次 resolve
    Menu.buildFromTemplate(template).popup({ window: win, callback: () => setTimeout(() => resolve(null), 100) })
  })
}
