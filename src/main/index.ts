import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { registerIpcHandlers, disposeContentWatcher } from './ipc'
import { listContent } from './services/contentService'
import { getSettings } from './services/settingsService'
import { armSelfcheck, failSelfcheck } from './selfcheck'

/**
 * 主进程入口：窗口生命周期 + 安全基线（contextIsolation / sandbox / CSP / 导航守卫）。
 * P0 目标：启动后能列出 my-blog/content 四分区清单。
 */

const isDev = !app.isPackaged

function rendererDevUrl(): string | undefined {
  return process.env['ELECTRON_RENDERER_URL']
}

function contentSecurityPolicy(): string {
  const devUrl = rendererDevUrl()
  const common = [
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ]
  if (isDev && devUrl) {
    const wsUrl = devUrl.replace(/^http/, 'ws')
    return [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devUrl}`,
      `style-src 'self' 'unsafe-inline' ${devUrl}`,
      `connect-src 'self' ${devUrl} ${wsUrl}`,
      ...common
    ].join('; ')
  }
  // 生产：仅 file:// 自身，不加载任何远程资源
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    ...common
  ].join('; ')
}

function isAllowedNavigation(url: string): boolean {
  const devUrl = rendererDevUrl()
  if (isDev && devUrl) return url.startsWith(devUrl)
  return url.startsWith('file://')
}

function openExternalSafe(url: string): void {
  try {
    if (new URL(url).protocol === 'https:') void shell.openExternal(url)
  } catch {
    /* 非法 URL 直接忽略 */
  }
}

function applySecurityPolicies(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()]
      }
    })
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url)
      return { action: 'deny' }
    })
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1116',
    title: 'my-blog CMS',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  const devUrl = rendererDevUrl()
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function logStartupSummary(): void {
  const settings = getSettings()
  console.log('[cms] workspaceRoot = ' + (settings.workspaceRoot || '(未配置)'))
  console.log('[cms] proxy = ' + settings.proxy)
  try {
    const payload = listContent()
    console.log(
      '[cms] contentSummary ' +
        JSON.stringify(
          payload.sections.map((item) => ({ section: item.section, count: item.count }))
        )
    )
  } catch (err) {
    console.error('[cms] 读取内容清单失败：' + (err instanceof Error ? err.message : String(err)))
    failSelfcheck('内容清单读取失败')
  }
}

void app.whenReady().then(() => {
  app.setAppUserModelId('com.xuwenshi.mycms')
  applySecurityPolicies()
  registerIpcHandlers()
  logStartupSummary()
  createWindow()
  armSelfcheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前释放 content/ 监听句柄，避免 fs.watch 残留
app.on('will-quit', () => {
  disposeContentWatcher()
})