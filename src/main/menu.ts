import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC_CHANNELS, type MenuCommand } from '../shared/types'

/**
 * 原生应用菜单。设计 spec 要求：每个快捷键都能在菜单里找到，
 * 所以 ⌘ 组合键统一在这里注册，点击后把命令发给渲染进程。
 */
export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  const send = (cmd: MenuCommand) => (): void => {
    getWindow()?.webContents.send(IPC_CHANNELS.MENU_COMMAND, cmd)
  }
  const item = (label: string, accelerator: string, cmd: MenuCommand): MenuItemConstructorOptions => ({
    label, accelerator, click: send(cmd),
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        item('设置…', 'CmdOrCtrl+,', 'settings'),
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
        { role: 'selectAll', label: '全选' },
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
        { type: 'separator' },
        item('显示/隐藏侧边栏', 'CmdOrCtrl+Alt+S', 'toggle-sidebar'),
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
