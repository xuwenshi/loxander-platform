import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import {
  registerIpcHandlers,
  disposeContentWatcher,
  disposePreview,
  previewWhitelist,
  autoStartPreview
} from './ipc'
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

/**
 * 预览 webview 的导航白名单：只允许本机 dev server 的 origin（含 localhost 与 127.0.0.1）。
 * 白名单由主进程侧 devServer 的就绪事件动态登记（端口可能被 Next 自增）。
 */
function isPreviewUrl(url: string): boolean {
  return previewWhitelist().some((origin) => url.startsWith(origin))
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

  /**
   * 每个 WebContents 创建时都挂一遍守卫：
   * - will-attach-webview：预览 <webview> 的安全基线（必须在 attach 之前把 preload 抹掉、
   *   Node 关掉；src 不在预览白名单内直接拒绝挂载）。该事件挂在宿主 WebContents 上，不是 app。
   * - will-navigate：webview 只允许预览 origin，主窗口/其它内容沿用原守卫逻辑。
   */
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      const src = typeof params.src === 'string' ? params.src : ''
      if (!src || !isPreviewUrl(src)) event.preventDefault()
    })

    const isWebview = contents.getType() === 'webview'
    contents.on('will-navigate', (event, url) => {
      const allowed = isWebview ? isPreviewUrl(url) : isAllowedNavigation(url)
      if (!allowed) event.preventDefault()
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
      spellcheck: false,
      // 本地实时预览用 <webview> 承载真实博客页面（独立 partition，见 will-attach-webview 加固）
      webviewTag: true
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
  // 窗口必须先存在：dev server 的状态事件按窗口广播，创建前启动会把事件全丢掉
  autoStartPreview()
  armSelfcheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前释放 content/ 监听句柄与预览 dev server，避免 fs.watch 与 node 子进程残留
app.on('will-quit', () => {
  disposeContentWatcher()
  // stop() 内部用 taskkill 同步收尾，这里不 await 也能保证进程树被清掉
  disposePreview()
})