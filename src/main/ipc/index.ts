import { app, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CmsError } from '../errors'
import { listContent } from '../services/contentService'
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
import { parseRepoSlug, pollDeploy, queryDeploy, type DeployProvider } from '../services/deployService'
import { createHttpClient } from '../services/httpClient'
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

interface SaveBodyPayload {
  section: string
  slug: string
  body: string
  expected: FileFingerprint
  force?: boolean
}

export function registerIpcHandlers(): void {
  handle('settings:get', () => getSettings())
  handle('settings:set', (patch: Partial<Settings>) => updateSettings(patch))

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
    return { canceled: false, settings: updateSettings({ workspaceRoot: picked }) }
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
    return deleteEntry(root, backupRoot(), assertSection(payload?.section), payload?.slug as string)
  })

  handle('content:rename', (payload: { section?: unknown; slug?: unknown; nextSlug?: unknown }) => {
    const root = requireWorkspaceRoot()
    return renameEntry(root, assertSection(payload?.section), payload?.slug as string, payload?.nextSlug as string)
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

  handle('git:pull', () => {
    const root = requireWorkspaceRoot()
    const { proxy, remote, branch } = getSettings()
    return pullRecover({ workspaceRoot: root, proxy, remote, branch })
  })

  handle('publish:state', () => {
    const { remote, branch } = getSettings()
    return readPublishState(stateRoot(), branch, remote)
  })

  handle(
    'publish:run',
    (payload: { message?: unknown; files?: unknown; confirmed?: unknown }) => {
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
    }
  )

  handle('publish:retryPush', () => {
    const root = requireWorkspaceRoot()
    const { proxy, remote, branch } = getSettings()
    return retryPush({ workspaceRoot: root, stateRoot: stateRoot(), proxy, remote, branch })
  })

  handle('publish:clear', () => {
    const { remote, branch } = getSettings()
    return clearPublishState(stateRoot(), branch, remote)
  })

  // 一键回滚（P5 可选）：对上一次发布生成反向提交（git revert），绝不改写历史
  handle('publish:revert', (payload?: { confirmed?: unknown; push?: unknown }) => {
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

  // ---- 部署回读（P4）：GitHub commit status（零配置）/ Vercel API（Token 增强） ----

  handle('deploy:status', async (payload?: { provider?: unknown; sha?: unknown; wait?: unknown }) => {
    const root = requireWorkspaceRoot()
    const settings = getSettings()

    const provider: DeployProvider =
      payload?.provider === 'vercel' || payload?.provider === 'github'
        ? payload.provider
        : settings.deployProvider

    // SHA 优先用调用方传入；否则回落到最近一次「已推送」的发布状态
    const state = readPublishState(stateRoot(), settings.branch, settings.remote)
    const sha = String(payload?.sha ?? state.commitSha ?? '').trim()

    // 仓库标识：设置里优先；留空则从 git remote 推导 owner/repo
    let repository = settings.repository.trim()
    if (!repository) {
      repository = parseRepoSlug(await getRemoteUrl(root, settings.proxy, settings.remote)) ?? ''
    }

    const common = {
      provider,
      repository,
      sha,
      vercelToken: settings.vercelToken || undefined,
      vercelProjectId: settings.vercelProjectId || undefined,
      http: createHttpClient(settings.proxy)
    }

    // wait=false：只查一次（供 UI 快速刷新）；默认轮询到就绪/失败/超时
    if (payload?.wait === false) return queryDeploy(common)

    return pollDeploy({ ...common, productionUrl: settings.productionUrl || undefined })
  })

  // renderer 就绪回报：普通模式下仅用于日志；自检模式下据此判定 P0 链路打通
  handle('runtime:ready', (payload: unknown) => {
    completeSelfcheck({ renderer: payload, sandboxed: true })
    return { acknowledged: true, selfcheck: isSelfcheck(), appVersion: app.getVersion() }
  })
}