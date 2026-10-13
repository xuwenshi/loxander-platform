import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  CmsApi,
  ContentChangeEvent,
  FrontmatterPatch,
  FileFingerprint,
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
    clear: () => ipcRenderer.invoke('publish:clear')
  },
  deploy: {
    status: (payload?: { provider?: 'github' | 'vercel'; sha?: string; wait?: boolean }) =>
      ipcRenderer.invoke('deploy:status', payload)
  },
  runtime: {
    ready: (payload: ReadyPayload) => ipcRenderer.invoke('runtime:ready', payload),
    /**
     * 订阅 content/ 目录的外部改动。只暴露这一个事件通道，且不透传 IpcRendererEvent
     * （避免把 sender 等内部对象泄漏给 renderer）；返回退订函数供 React 清理。
     */
    onContentChanged: (cb: (event: ContentChangeEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: ContentChangeEvent): void => cb(payload)
      ipcRenderer.on('content:changed', listener)
      return () => {
        ipcRenderer.removeListener('content:changed', listener)
      }
    }
  },
  versions: readVersions()
}

contextBridge.exposeInMainWorld('cms', api)