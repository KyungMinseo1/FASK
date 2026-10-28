import './profile'
import { app, shell, BrowserWindow, dialog, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerPersonal, type PersonalRuntime } from './personal'

let mainWindow: BrowserWindow | null = null

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/' })
  }
}

app.whenReady().then(() => {
  if (!ownsInstance) return
  electronApp.setAppUserModelId('com.fask.personal')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  let personal: PersonalRuntime
  try {
    personal = registerPersonal(join(app.getPath('userData'), 'personal'), () => mainWindow)
  } catch (e) {
    // The schema migration rolls back on failure and the pre-upgrade copy stays on disk.
    dialog.showErrorBox(
      'FASK 데이터 업그레이드 실패',
      `${e instanceof Error ? e.message : String(e)}\n\n기존 데이터는 변경되지 않았습니다.`
    )
    app.quit()
    return
  }
  createWindow()
  personal.initializeShortcut()
  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
