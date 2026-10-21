import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CmsApi,
  AutoPublishEvent,
  ContentChangeEvent,
  DeployStatus,
  FrontmatterPatch,
  FileFingerprint,
  PreviewStatus,
  PublishState,
  ReadyPayload,
  Settings
} from './api'

/**
 * 安全桥：只做转发，不含业务逻辑。
 * sandbox: true 下 preload 仅允许依赖 electron 的 contextBridge / ipcRenderer，
 * 因此这里不 import 任何 Node 模块。
 */

function readVersions(): { electron: string; chrome: string; node: string } {
  try {
    const v = process.versions
    return { electron: v.electron ?? '', chrome: v.chrome ?? '', node: v.node ?? '' }
  } catch {
    return { electron: '', chrome: '', node: '' }
  }
}

interface PatchPayload {
  section: string
  slug: string
  patch: FrontmatterPatch
  body?: string
  expected: FileFingerprint
  force?: boolean
}

interface SaveBodyPayload {
  section: string
  slug: string
  body: string
  expected: FileFingerprint
  force?: boolean
}

/**
 * 统一事件订阅封装：只透传 payload，绝不把 IpcRendererEvent（含 sender）泄漏给 renderer；
 * 返回退订函数供 React 组件在 cleanup 中调用，避免热更新重复注册。
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: CmsApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
    pickWorkspace: () => ipcRenderer.invoke('workspace:pick')
  },
  content: {
    list: (section?: string) => ipcRenderer.invoke('content:list', section),
    schema: () => ipcRenderer.invoke('content:schema'),
    read: (section: string, slug: string) => ipcRenderer.invoke('content:read', section, slug),
    patchFrontmatter: (payload: PatchPayload) =>
      ipcRenderer.invoke('content:patchFrontmatter', payload),
    saveBody: (payload: SaveBodyPayload) => ipcRenderer.invoke('content:saveBody', payload),
    dirtyDiff: (payload: { section: string; slug: string; patch?: FrontmatterPatch; body?: string }) =>
      ipcRenderer.invoke('content:dirtyDiff', payload),
    validate: () => ipcRenderer.invoke('content:validate'),
    covers: () => ipcRenderer.invoke('content:covers'),
    create: (payload: { section: string; slug: string; title?: string; date?: string }) =>
      ipcRenderer.invoke('content:create', payload),
    delete: (payload: { section: string; slug: string }) => ipcRenderer.invoke('content:delete', payload),
    rename: (payload: { section: string; slug: string; nextSlug: string }) =>
      ipcRenderer.invoke('content:rename', payload)
  },
  groups: {
    create: (payload: { section: string; name: string }) => ipcRenderer.invoke('groups:create', payload),
    rename: (payload: { section: string; id: string; name: string }) =>
      ipcRenderer.invoke('groups:rename', payload),
    remove: (payload: { section: string; id: string }) => ipcRenderer.invoke('groups:delete', payload),
    assign: (payload: { section: string; slug: string; groupId: string | null }) =>
      ipcRenderer.invoke('groups:assign', payload)
  },
  git: {
    status: () => ipcRenderer.invoke('git:status'),
    diff: (scope?: { staged?: boolean; files?: string[] }) => ipcRenderer.invoke('git:diff', scope),
    preflight: () => ipcRenderer.invoke('git:preflight'),
    pull: () => ipcRenderer.invoke('git:pull')
  },
  publish: {
    state: () => ipcRenderer.invoke('publish:state'),
    run: (payload: { message: string; files: string[]; confirmed: boolean }) =>
      ipcRenderer.invoke('publish:run', payload),
    retryPush: () => ipcRenderer.invoke('publish:retryPush'),
    revert: (payload?: { confirmed?: boolean; push?: boolean }) =>
      ipcRenderer.invoke('publish:revert', payload),
    clear: () => ipcRenderer.invoke('publish:clear'),
    setAuto: (auto: boolean) => ipcRenderer.invoke('publish:setAuto', auto),
    autoHold: (hold: boolean) => ipcRenderer.invoke('publish:autoHold', hold)
  },
  preview: {
    start: () => ipcRenderer.invoke('preview:start'),
    stop: () => ipcRenderer.invoke('preview:stop'),
    restart: () => ipcRenderer.invoke('preview:restart'),
    status: () => ipcRenderer.invoke('preview:status'),
    logs: () => ipcRenderer.invoke('preview:logs')
  },
  deploy: {
    status: (payload?: { provider?: 'github' | 'vercel'; sha?: string; wait?: boolean }) =>
      ipcRenderer.invoke('deploy:status', payload)
  },
  runtime: {
    ready: (payload: ReadyPayload) => ipcRenderer.invoke('runtime:ready', payload),
    /** 订阅 content/ 目录的外部改动 */
    onContentChanged: (cb: (event: ContentChangeEvent) => void) => subscribe('content:changed', cb),
    /** 订阅预览 dev server 状态 */
    onPreviewEvent: (cb: (status: PreviewStatus) => void) => subscribe('preview:event', cb),
    /** 订阅自动发布后的发布状态 */
    onPublishChanged: (cb: (state: PublishState) => void) => subscribe('publish:changed', cb),
    /** 订阅自动发布后的一次部署回读结果 */
    onDeployChanged: (cb: (status: DeployStatus) => void) => subscribe('publish:deployChanged', cb),
    /** 订阅自动发布的决策/结果（跳过原因、实际提交清单） */
    onAutoPublishEvent: (cb: (event: AutoPublishEvent) => void) => subscribe('publish:autoEvent', cb)
  },
  versions: readVersions()
}

contextBridge.exposeInMainWorld('cms', api)