import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CmsError } from '../errors'
import { listContent } from '../services/contentService'
import {
  createContentWatcher,
  type ContentChangeEvent,
  type ContentWatcherHandle
} from '../services/contentWatcherService'
import {
  createEntry,
  deleteEntry,
  dirtyDiff,
  listCovers,
  readEntry,
  renameEntry,
  saveEntry,
  validateWorkspace
} from '../services/entryService'
import type { FrontmatterPatch } from '../services/contentPatchService'
import type { FileFingerprint } from '../services/atomicFile'
import { getDiff, getRemoteUrl, getStatus } from '../services/gitService'
import {
  clearPublishState,
  preflight,
  publish,
  pullRecover,
  readPublishState,
  retryPush,
  rollbackLast
} from '../services/publishService'
import { parseRepoSlug, pollDeploy, queryDeploy, type DeployProvider, type DeployStatus } from '../services/deployService'
import { createDevServer, type DevServerHandle, type DevServerStatus } from '../services/devServerService'
import { createAutoPublisher, type AutoPublishEvent, type AutoPublisher } from '../services/autoPublishService'
import { createHttpClient } from '../services/httpClient'
import {
  assignEntry,
  createGroup,
  deleteGroup,
  dropAssignment,
  moveAssignment,
  renameGroup,
  type GroupStore
} from '../services/groupService'
import { assertSection, SECTION_SCHEMAS } from '../services/schemaService'
import { getSettings, updateSettings, type Settings } from '../services/settingsService'
import { completeSelfcheck, isSelfcheck } from '../selfcheck'

/**
 * IPC 统一注册：命名空间化通道 + 统一信封 { ok:true,data } | { ok:false,code,message,hint,detail }。
 * renderer 无任何 Node 能力，一切特权操作都必须经过这里；section/slug 全部视为不可信输入。
 */

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; hint?: string; detail?: unknown }

function toError(err: unknown): CmsError {
  if (err instanceof CmsError) return err
  return new CmsError('INTERNAL', err instanceof Error ? err.message : String(err))
}

function handle(channel: string, handler: (...args: any[]) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Envelope<unknown>> => {
    try {
      return { ok: true, data: await handler(...args) }
    } catch (err) {
      const error = toError(err)
      console.error(`[cms] IPC ${channel} 失败`, error.code, error.message)
      return {
        ok: false,
        code: error.code,
        message: error.message,
        hint: error.hint,
        detail: error.detail
      }
    }
  })
}

/** 备份落在 CMS 自己的 userData 下，绝不写进博客仓库（ADR-8） */
function backupRoot(): string {
  return join(app.getPath('userData'), '.cms-backups')
}

/** 发布状态同样落在 CMS 自己的 userData，避免污染博客仓库 */
function stateRoot(): string {
  return app.getPath('userData')
}

function requireWorkspaceRoot(): string {
  const root = getSettings().workspaceRoot
  if (!root) {
    throw new CmsError('WORKSPACE_NOT_FOUND', '尚未配置文件工作区', '请在设置中指定 my-blog 仓库根目录')
  }
  return root
}

interface PatchPayload {
  section: string
  slug: string
  patch: FrontmatterPatch
  body?: string
  expected: FileFingerprint
  force?: boolean
}

/* ---- 外部改动感知：watcher 跟随当前工作区，退出时释放 ---- */

let contentWatcher: ContentWatcherHandle | null = null
/** 当前正在监听的工作区根；用于判断是否需要重建 watcher */
let watchedRoot = ''

/** 把事件广播给所有窗口（renderer 侧再用 workspaceRoot 过滤过期事件） */
function broadcastContentChange(event: ContentChangeEvent): void {
  console.log('[cms] content 外部改动：' + event.paths.join(', '))
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('content:changed', event)
  }
  // 自动发布挂在这里：CMS 自己的保存同样会触发 watcher，因此不需要在 renderer 另开写路径
  autoPublisher.onContentChanged(event)
}

/**
 * 让 watcher 与当前工作区保持一致：根未变则什么都不做；
 * 变了先关旧再开新；根被清空则直接关闭。选择工作区与保存设置后都会调用。
 */
function syncContentWatcher(): void {
  const root = getSettings().workspaceRoot
  if (contentWatcher && watchedRoot === root) return
  contentWatcher?.close()
  contentWatcher = null
  watchedRoot = root
  if (!root) return
  contentWatcher = createContentWatcher({ workspaceRoot: root, onChanges: broadcastContentChange })
  console.log('[cms] 已开始监听 ' + join(root, 'content'))
}

/** 应用退出时调用：释放 fs.watch 句柄，避免残留监听 */
export function disposeContentWatcher(): void {
  contentWatcher?.close()
  contentWatcher = null
  watchedRoot = ''
}

/* ---- 本地实时预览（A）：dev server 生命周期 + webview 导航白名单 ---- */

let devServer: DevServerHandle | null = null
/** 当前 dev server 的配置指纹：workspaceRoot|port|nodePath 变化时需重建实例 */
let devServerKey = ''
/** webview 导航白名单：localhost 与 127.0.0.1 两种写法（端口以 dev server 回传为准） */
const previewOrigins = new Set<string>()
/** 最近一次预览状态：未创建句柄时也用得上（供 preview:status 同步返回） */
let previewState: DevServerStatus = { state: 'stopped', pid: null, origin: null, port: null, message: null }

function devServerFingerprint(settings: Settings, workspaceRoot: string): string {
  return `${workspaceRoot}|${settings.previewPort}|${settings.nodePath}`
}

/** dev server 状态变化统一出口：登记白名单 + 广播给所有窗口 */
function broadcastPreview(status: DevServerStatus): void {
  previewState = status
  previewOrigins.clear()
  if (status.port) {
    previewOrigins.add(`http://localhost:${status.port}`)
    previewOrigins.add(`http://127.0.0.1:${status.port}`)
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('preview:event', status)
  }
}

/** 取（必要时重建）当前工作区对应的 dev server 句柄；未配置工作区时报错 */
function ensureDevServer(): DevServerHandle {
  const root = requireWorkspaceRoot()
  const settings = getSettings()
  const key = devServerFingerprint(settings, root)
  if (devServer && devServerKey === key) return devServer
  // 配置变更：先停旧实例再建新实例（端口 / node / 工作区都可能换了）
  if (devServer) {
    void devServer.stop()
    devServer = null
  }
  devServer = createDevServer({
    workspaceRoot: root,
    port: settings.previewPort,
    nodePath: settings.nodePath || undefined,
    onEvent: broadcastPreview
  })
  devServerKey = key
  return devServer
}

/** webview 导航白名单（供主进程安全守卫读取）：只含本机 dev server origin */
export function previewWhitelist(): string[] {
  return [...previewOrigins]
}

/** 应用退出时停止预览 dev server（stop 内部同步 taskkill，故不 await 也安全） */
export function disposePreview(): void {
  void devServer?.stop()
  devServer = null
  devServerKey = ''
  previewOrigins.clear()
  previewState = { state: 'stopped', pid: null, origin: null, port: null, message: null }
}

/** 预览运行中且配置变更时：停旧起新，保证 webview 指向新端口/新工作区 */
async function restartPreviewIfRunning(): Promise<void> {
  if (!devServer) return
  const wasRunning = previewState.state === 'ready' || previewState.state === 'starting'
  await devServer.stop()
  devServer = null
  devServerKey = ''
  if (wasRunning) await ensureDevServer().start()
}

/* ---- 线上自动发布（B）：content/ 变更 → debounce → 预检 → 提交 → 推送 → 回读部署 ---- */

/** renderer 检测到冲突 / 外部改动时置位，暂停自动发布 */
let autoHold = false

/** 构造一次部署查询所需的公共参数（仓库标识留空时由 git remote 推导 owner/repo） */
async function buildDeployQuery(provider: DeployProvider, sha: string): Promise<Parameters<typeof queryDeploy>[0]> {
  const root = requireWorkspaceRoot()
  const settings = getSettings()
  let repository = settings.repository.trim()
  if (!repository) {
    repository = parseRepoSlug(await getRemoteUrl(root, settings.proxy, settings.remote)) ?? ''
  }
  return {
    provider,
    repository,
    sha,
    vercelToken: settings.vercelToken || undefined,
    vercelProjectId: settings.vercelProjectId || undefined,
    http: createHttpClient(settings.proxy)
  }
}

function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 自动发布的决策 / 结果一律显式广播，绝不静默 */
function broadcastAutoPublish(event: AutoPublishEvent): void {
  console.log(`[cms] 自动发布 ${event.kind}${event.reason ? '：' + event.reason : ''}`)
  broadcastToWindows('publish:autoEvent', event)
  if (event.kind !== 'published' || !event.state) return
  // 通知 renderer 更新发布状态（renderer 收到后再复用既有 runDeployStatus 轮询）
  broadcastToWindows('publish:changed', event.state)
  if (event.state.phase === 'pushed' && event.state.commitSha) {
    const sha = event.state.commitSha
    void buildDeployQuery(getSettings().deployProvider, sha)
      .then((options) => queryDeploy(options))
      .then((deploy: DeployStatus) => broadcastToWindows('publish:deployChanged', deploy))
      .catch((err) => console.warn('[cms] 自动发布后回读部署失败：' + (err instanceof Error ? err.message : String(err))))
  }
}

/** 自动发布服务：特权动作注入（预检 / 发布 / 广播），服务本身不含 electron 依赖 */
const autoPublisher: AutoPublisher = createAutoPublisher({
  isEnabled: () => getSettings().autoPublish === true,
  getDebounceMs: () => getSettings().autoPublishDebounceMs,
  pathExists: (relativePath) => {
    const root = getSettings().workspaceRoot
    return Boolean(root) && existsSync(join(root, relativePath))
  },
  preflight: async () => {
    const root = requireWorkspaceRoot()
    const { proxy, remote, branch } = getSettings()
    const report = await preflight({ workspaceRoot: root, proxy, remote, branch })
    return { blocking: report.blocking.length, contentFiles: report.contentFiles }
  },
  publish: ({ message, files }) => {
    const root = requireWorkspaceRoot()
    const { proxy, remote, branch } = getSettings()
    return publish({
      workspaceRoot: root,
      stateRoot: stateRoot(),
      proxy,
      remote,
      branch,
      message,
      files,
      confirmed: true
    })
  },
  onEvent: broadcastAutoPublish
})

/**
 * 抑制窗口包裹：publish / retryPush / rollback / pull 都会改写 content/，进而触发 watcher；
 * 操作期间用长窗口屏蔽，结束后再补 1.5s，避免自动发布被自己触发成环。
 */
async function withSuppressedWatcher<T>(fn: () => Promise<T>): Promise<T> {
  autoPublisher.suppress(120_000)
  try {
    return await fn()
  } finally {
    autoPublisher.suppress(1500)
  }
}

interface SaveBodyPayload {
  section: string
  slug: string
  body: string
  expected: FileFingerprint
  force?: boolean
}

export function registerIpcHandlers(): void {
  handle('settings:get', () => getSettings())
  handle('settings:set', async (patch: Partial<Settings>) => {
    const next = updateSettings(patch)
    // 工作区根可能被改动：让 watcher 立即跟随新根
    if (patch?.workspaceRoot !== undefined) syncContentWatcher()
    // 工作区 / 端口 / node 变化会影响 dev server 指向：正在预览则停旧起新
    if (
      patch?.workspaceRoot !== undefined ||
      patch?.previewPort !== undefined ||
      patch?.nodePath !== undefined
    ) {
      await restartPreviewIfRunning()
    }
    return next
  })

  handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 my-blog 仓库根目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, settings: getSettings() }
    const picked = result.filePaths[0]
    if (!existsSync(join(picked, 'content'))) {
      throw new CmsError('WORKSPACE_NO_CONTENT', `所选目录下没有 content/：${picked}`, '请选择 my-blog 仓库根目录')
    }
    const settings = updateSettings({ workspaceRoot: picked })
    syncContentWatcher()
    // 换了工作区：预览必须跟着换（旧 dev server 指向的是老仓库）
    await restartPreviewIfRunning()
    return { canceled: false, settings }
  })

  handle('content:list', (section?: unknown) => listContent(section))

  // 表单渲染所需的 schema：由主进程单一来源下发，renderer 不重复维护契约
  handle('content:schema', () => SECTION_SCHEMAS)

  handle('content:read', (section: unknown, slug: unknown) => {
    const root = requireWorkspaceRoot()
    return readEntry(root, assertSection(section), String(slug))
  })

  handle('content:patchFrontmatter', (payload: PatchPayload) => {
    const root = requireWorkspaceRoot()
    return saveEntry({
      workspaceRoot: root,
      backupRoot: backupRoot(),
      section: assertSection(payload.section),
      slug: String(payload.slug),
      patch: payload.patch,
      body: payload.body,
      expected: payload.expected,
      force: payload.force
    })
  })

  handle('content:saveBody', (payload: SaveBodyPayload) => {
    const root = requireWorkspaceRoot()
    return saveEntry({
      workspaceRoot: root,
      backupRoot: backupRoot(),
      section: assertSection(payload.section),
      slug: String(payload.slug),
      body: payload.body,
      expected: payload.expected,
      force: payload.force
    })
  })

  handle('content:dirtyDiff', (payload: { section: unknown; slug: unknown; patch?: FrontmatterPatch; body?: string }) => {
    const root = requireWorkspaceRoot()
    return dirtyDiff(root, assertSection(payload.section), String(payload.slug), payload.patch, payload.body)
  })

  handle('content:validate', () => {
    const root = requireWorkspaceRoot()
    return validateWorkspace(root)
  })

  // ---- 内容管理闭环（P3）：新建 / 删除 / 重命名 / 封面枚举 ----

  handle('content:covers', () => listCovers(requireWorkspaceRoot()))

  handle('content:create', (payload: { section?: unknown; slug?: unknown; title?: unknown; date?: unknown }) => {
    const root = requireWorkspaceRoot()
    return createEntry({
      workspaceRoot: root,
      section: assertSection(payload?.section),
      slug: payload?.slug as string,
      title: payload?.title === undefined ? undefined : String(payload.title),
      date: payload?.date === undefined ? undefined : String(payload.date)
    })
  })

  handle('content:delete', (payload: { section?: unknown; slug?: unknown }) => {
    const root = requireWorkspaceRoot()
    const section = assertSection(payload?.section)
    const slug = String(payload?.slug)
    const result = deleteEntry(root, backupRoot(), section, slug)
    // 级联：文件没了，虚拟分组的归属键也一并清掉，避免残留悬空归属
    const before = getSettings().groups
    const after = dropAssignment(before, section, slug)
    if (after !== before) updateSettings({ groups: after })
    return result
  })

  handle('content:rename', (payload: { section?: unknown; slug?: unknown; nextSlug?: unknown }) => {
    const root = requireWorkspaceRoot()
    const section = assertSection(payload?.section)
    const slug = String(payload?.slug)
    const nextSlug = String(payload?.nextSlug)
    const result = renameEntry(root, section, slug, nextSlug)
    // 级联：归属以 slug 为键，改名后要把键迁到新 slug，否则归类丢失
    const before = getSettings().groups
    const after = moveAssignment(before, section, slug, nextSlug)
    if (after !== before) updateSettings({ groups: after })
    return result
  })

  // ---- 内容虚拟分组（文件夹）：只写 <userData>/settings.json，绝不触碰博客仓库 ----

  /** 统一出口：读当前分组 → 纯函数变换 → 落盘 → 回传新值（变换未改动时直接返回原值，不写盘） */
  function mutateGroups(mutate: (store: GroupStore) => GroupStore): GroupStore {
    const before = getSettings().groups
    const after = mutate(before)
    if (after === before) return before
    return updateSettings({ groups: after }).groups
  }

  handle('groups:create', (payload: { section?: unknown; name?: unknown }) => {
    const section = assertSection(payload?.section)
    return mutateGroups((store) => createGroup(store, section, payload?.name))
  })

  handle('groups:rename', (payload: { section?: unknown; id?: unknown; name?: unknown }) => {
    const section = assertSection(payload?.section)
    return mutateGroups((store) => renameGroup(store, section, String(payload?.id), payload?.name))
  })

  handle('groups:delete', (payload: { section?: unknown; id?: unknown }) => {
    const section = assertSection(payload?.section)
    return mutateGroups((store) => deleteGroup(store, section, String(payload?.id)))
  })

  handle('groups:assign', (payload: { section?: unknown; slug?: unknown; groupId?: unknown }) => {
    const section = assertSection(payload?.section)
    const raw = payload?.groupId
    const groupId = raw === null || raw === undefined ? null : String(raw)
    return mutateGroups((store) => assignEntry(store, section, String(payload?.slug), groupId))
  })

  // ---- Git 闸门（P2）：只读 + 显式文件清单；push/pull 注入代理 ----

  handle('git:status', () => {
    const { workspaceRoot, proxy } = getSettings()
    if (!workspaceRoot) {
      throw new CmsError('WORKSPACE_NOT_FOUND', '尚未配置文件工作区', '请在设置中指定 my-blog 仓库根目录')
    }
    return getStatus(workspaceRoot, proxy)
  })

  handle('git:diff', (scope?: { staged?: boolean; files?: string[] }) => {
    const { workspaceRoot, proxy } = getSettings()
    if (!workspaceRoot) {
      throw new CmsError('WORKSPACE_NOT_FOUND', '尚未配置文件工作区', '请在设置中指定 my-blog 仓库根目录')
    }
    return getDiff(workspaceRoot, proxy, {
      staged: Boolean(scope?.staged),
      files: Array.isArray(scope?.files) ? scope?.files : undefined
    })
  })

  handle('git:preflight', () => {
    const root = requireWorkspaceRoot()
    const { proxy, remote, branch } = getSettings()
    return preflight({ workspaceRoot: root, proxy, remote, branch })
  })

  handle('git:pull', () =>
    withSuppressedWatcher(() => {
      const root = requireWorkspaceRoot()
      const { proxy, remote, branch } = getSettings()
      return pullRecover({ workspaceRoot: root, proxy, remote, branch })
    })
  )

  handle('publish:state', () => {
    const { remote, branch } = getSettings()
    return readPublishState(stateRoot(), branch, remote)
  })

  handle(
    'publish:run',
    (payload: { message?: unknown; files?: unknown; confirmed?: unknown }) =>
      withSuppressedWatcher(() => {
        const root = requireWorkspaceRoot()
        const { proxy, remote, branch } = getSettings()
        return publish({
          workspaceRoot: root,
          stateRoot: stateRoot(),
          proxy,
          remote,
          branch,
          message: String(payload?.message ?? ''),
          files: payload?.files,
          confirmed: payload?.confirmed === true
        })
      })
  )

  handle('publish:retryPush', () =>
    withSuppressedWatcher(() => {
      const root = requireWorkspaceRoot()
      const { proxy, remote, branch } = getSettings()
      return retryPush({ workspaceRoot: root, stateRoot: stateRoot(), proxy, remote, branch })
    })
  )

  handle('publish:clear', () => {
    const { remote, branch } = getSettings()
    return clearPublishState(stateRoot(), branch, remote)
  })

  // 一键回滚（P5 可选）：对上一次发布生成反向提交（git revert），绝不改写历史
  handle('publish:revert', (payload?: { confirmed?: unknown; push?: unknown }) =>
    withSuppressedWatcher(() => {
      const root = requireWorkspaceRoot()
      const { proxy, remote, branch } = getSettings()
      return rollbackLast({
        workspaceRoot: root,
        stateRoot: stateRoot(),
        proxy,
        remote,
        branch,
        confirmed: payload?.confirmed === true,
        push: payload?.push !== false
      })
    })
  )

  // ---- 自动发布（B）：UI 开关 + hold（renderer 检测到冲突/外部改动时置位，暂停自动发布） ----

  handle('publish:setAuto', (auto: unknown) => updateSettings({ autoPublish: auto === true }))

  handle('publish:autoHold', (hold: unknown) => {
    autoHold = hold === true
    autoPublisher.setHold(autoHold)
    return { hold: autoHold }
  })

  // ---- 本地实时预览（A）：dev server 生命周期（webview 用独立 partition 承载真实页面）----

  handle('preview:start', () => ensureDevServer().start())
  handle('preview:stop', () => (devServer ? devServer.stop() : previewState))
  handle('preview:restart', () => ensureDevServer().restart())
  handle('preview:status', () => (devServer ? devServer.status() : previewState))
  handle('preview:logs', () => (devServer ? devServer.logs() : ''))

  // ---- 部署回读（P4）：GitHub commit status（零配置）/ Vercel API（Token 增强） ----

  handle('deploy:status', async (payload?: { provider?: unknown; sha?: unknown; wait?: unknown }) => {
    const settings = getSettings()

    const provider: DeployProvider =
      payload?.provider === 'vercel' || payload?.provider === 'github'
        ? payload.provider
        : settings.deployProvider

    // SHA 优先用调用方传入；否则回落到最近一次「已推送」的发布状态
    const state = readPublishState(stateRoot(), settings.branch, settings.remote)
    const sha = String(payload?.sha ?? state.commitSha ?? '').trim()

    // 仓库标识：设置里优先；留空则从 git remote 推导 owner/repo
    const common = await buildDeployQuery(provider, sha)

    // wait=false：只查一次（供 UI 快速刷新）；默认轮询到就绪/失败/超时
    if (payload?.wait === false) return queryDeploy(common)

    return pollDeploy({ ...common, productionUrl: settings.productionUrl || undefined })
  })

  // renderer 就绪回报：普通模式下仅用于日志；自检模式下据此判定 P0 链路打通
  handle('runtime:ready', (payload: unknown) => {
    completeSelfcheck({ renderer: payload, sandboxed: true })
    return { acknowledged: true, selfcheck: isSelfcheck(), appVersion: app.getVersion() }
  })

  // 启动即按当前工作区开始监听 content/（未配置工作区时静默跳过）
  syncContentWatcher()

  // 按设置决定是否开机即拉起本地预览 dev server（webview 面板默认不展开，用户点开即秒显示）
  const boot = getSettings()
  console.log(`[cms] 自动发布 = ${boot.autoPublish ? '开' : '关'}；本地预览自启 = ${boot.previewAutoStart ? '开' : '关'}`)
  if (boot.previewAutoStart && boot.workspaceRoot) {
    void ensureDevServer().start()
  }
}