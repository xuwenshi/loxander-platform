import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import { CmsError } from '../errors'
import { emptyGroupStore, sanitizeGroups, type GroupStore } from './groupService'

/**
 * 工作区与运行参数设置。
 * 注意：工作区 = 博客仓库根（含 content/ 的目录），CMS 从不写入自身目录以外的仓库代码。
 */

/** UI 主题模式：同时决定布局形态与配色（见 renderer 的 styles.css token 层） */
export type ThemeMode = 'soft' | 'dashboard' | 'writing' | 'developer'
/** 明暗外观：与主题模式正交，写到 <html data-scheme> */
export type ColorScheme = 'light' | 'dark'
/** 编辑器布局偏好（P2 编辑模式使用） */
export type EditorLayout = 'split' | 'editor' | 'preview'

export const THEME_MODES: readonly ThemeMode[] = ['soft', 'dashboard', 'writing', 'developer']
export const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark']
export const EDITOR_LAYOUTS: readonly EditorLayout[] = ['split', 'editor', 'preview']

export interface Settings {
  /** 博客仓库根目录（绝对路径） */
  workspaceRoot: string
  /** 远程请求使用的代理（本机直连 GitHub/Vercel 不通，必须注入） */
  proxy: string
  remote: string
  branch: string
  /** 预检是否附带 `npm run build`（默认关闭，慢） */
  preflightWithBuild: boolean
  /** 部署回读通道：github（零配置）或 vercel（需只读 Token） */
  deployProvider: 'github' | 'vercel'
  /** owner/repo；留空则由 git remote 自动推导 */
  repository: string
  /** Vercel 只读 Token（vercel 通道必需） */
  vercelToken: string
  /** Vercel 项目 ID（可选，缩小查询范围） */
  vercelProjectId: string
  /** 生产地址，用于「API 说 ready」后的 HTTP 复核（可留空跳过） */
  productionUrl: string

  /** ---- UI 偏好：与凭据同存 userData，不随仓库分发 ---- */
  themeMode: ThemeMode
  colorScheme: ColorScheme
  sidebarCollapsed: boolean
  editorLayout: EditorLayout

  /**
   * ---- 内容虚拟分组（文件夹）：CMS 侧归类元数据 ----
   * 只存这里，不写进博客仓库、不改磁盘结构（博客读取内容不递归，建子目录会导致文章不上站）。
   */
  groups: GroupStore
}

const FALLBACK: Omit<Settings, 'workspaceRoot'> = {
  proxy: 'socks5://127.0.0.1:10808',
  remote: 'origin',
  branch: 'main',
  preflightWithBuild: false,
  deployProvider: 'github',
  repository: '',
  vercelToken: '',
  vercelProjectId: '',
  productionUrl: '',
  themeMode: 'soft',
  colorScheme: 'dark',
  sidebarCollapsed: false,
  editorLayout: 'split',
  groups: emptyGroupStore()
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** 依次尝试：环境变量 → 记录值 → 与 electron-cms 同级的 my-blog → 上一级的 my-blog */
function detectWorkspaceRoot(): string | null {
  const candidates: string[] = []
  if (process.env.CMS_WORKSPACE) candidates.push(process.env.CMS_WORKSPACE)
  const appRoot = app.getAppPath()
  candidates.push(resolve(appRoot, '..', 'my-blog'))
  candidates.push(resolve(appRoot, '..', '..', 'my-blog'))
  // 打包后 appRoot 落在 app.asar 内，其上层不是用户目录；改为相对安装目录（exe 所在处）查找
  if (app.isPackaged) {
    const exeDir = dirname(process.execPath)
    candidates.push(resolve(exeDir, 'my-blog'))
    candidates.push(resolve(exeDir, '..', 'my-blog'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'content'))) return resolve(candidate)
  }
  return null
}

function assertWorkspaceRoot(root: unknown): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new CmsError('WORKSPACE_NOT_FOUND', '工作区路径为空', '请在设置中指定 my-blog 仓库根目录')
  }
  const absolute = resolve(root)
  if (!existsSync(absolute)) {
    throw new CmsError('WORKSPACE_NOT_FOUND', `目录不存在：${absolute}`)
  }
  if (!existsSync(join(absolute, 'content'))) {
    throw new CmsError('WORKSPACE_NO_CONTENT', `目录下没有 content/：${absolute}`, '请选择 my-blog 仓库根目录')
  }
  return absolute
}

interface StoredSettings {
  workspaceRoot?: string
  proxy?: string
  remote?: string
  branch?: string
  preflightWithBuild?: boolean
  deployProvider?: 'github' | 'vercel'
  repository?: string
  vercelToken?: string
  vercelProjectId?: string
  productionUrl?: string
  themeMode?: string
  colorScheme?: string
  sidebarCollapsed?: boolean
  editorLayout?: string
  /** 落盘未经校验，读取时一律走 sanitizeGroups 收敛 */
  groups?: unknown
}

function readStored(): StoredSettings {
  try {
    const file = settingsFile()
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8')) as StoredSettings
  } catch {
    return {}
  }
}

export function getSettings(): Settings {
  const stored = readStored()
  const root = stored.workspaceRoot && existsSync(join(stored.workspaceRoot, 'content'))
    ? resolve(stored.workspaceRoot)
    : detectWorkspaceRoot()

  return {
    workspaceRoot: root ?? '',
    proxy: stored.proxy ?? FALLBACK.proxy,
    remote: stored.remote ?? FALLBACK.remote,
    branch: stored.branch ?? FALLBACK.branch,
    preflightWithBuild: stored.preflightWithBuild ?? FALLBACK.preflightWithBuild,
    deployProvider: stored.deployProvider === 'vercel' ? 'vercel' : FALLBACK.deployProvider,
    repository: stored.repository ?? FALLBACK.repository,
    vercelToken: stored.vercelToken ?? FALLBACK.vercelToken,
    vercelProjectId: stored.vercelProjectId ?? FALLBACK.vercelProjectId,
    productionUrl: stored.productionUrl ?? FALLBACK.productionUrl,
    // 落盘值可能被手工改坏：一律收敛到合法枚举，未知值退回默认，避免 UI 拿到非法 data-mode
    themeMode: THEME_MODES.includes(stored.themeMode as ThemeMode)
      ? (stored.themeMode as ThemeMode)
      : FALLBACK.themeMode,
    colorScheme: COLOR_SCHEMES.includes(stored.colorScheme as ColorScheme)
      ? (stored.colorScheme as ColorScheme)
      : FALLBACK.colorScheme,
    sidebarCollapsed: stored.sidebarCollapsed === true,
    editorLayout: EDITOR_LAYOUTS.includes(stored.editorLayout as EditorLayout)
      ? (stored.editorLayout as EditorLayout)
      : FALLBACK.editorLayout,
    groups: sanitizeGroups(stored.groups)
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings()
  const next: Settings = { ...current }

  if (patch.workspaceRoot !== undefined) next.workspaceRoot = assertWorkspaceRoot(patch.workspaceRoot)
  if (patch.proxy !== undefined) next.proxy = String(patch.proxy).trim()
  if (patch.remote !== undefined) next.remote = String(patch.remote).trim()
  if (patch.branch !== undefined) next.branch = String(patch.branch).trim()
  if (patch.preflightWithBuild !== undefined) next.preflightWithBuild = Boolean(patch.preflightWithBuild)
  if (patch.deployProvider !== undefined) {
    next.deployProvider = patch.deployProvider === 'vercel' ? 'vercel' : 'github'
  }
  if (patch.repository !== undefined) next.repository = String(patch.repository).trim()
  if (patch.vercelToken !== undefined) next.vercelToken = String(patch.vercelToken).trim()
  if (patch.vercelProjectId !== undefined) next.vercelProjectId = String(patch.vercelProjectId).trim()
  if (patch.productionUrl !== undefined) next.productionUrl = String(patch.productionUrl).trim()
  if (patch.themeMode !== undefined && THEME_MODES.includes(patch.themeMode)) next.themeMode = patch.themeMode
  if (patch.colorScheme !== undefined && COLOR_SCHEMES.includes(patch.colorScheme)) {
    next.colorScheme = patch.colorScheme
  }
  if (patch.sidebarCollapsed !== undefined) next.sidebarCollapsed = Boolean(patch.sidebarCollapsed)
  if (patch.editorLayout !== undefined && EDITOR_LAYOUTS.includes(patch.editorLayout)) {
    next.editorLayout = patch.editorLayout
  }
  // 分组由 groupService 的纯函数算出后整份回传，这里只做收敛；不传则保留原值（next 已 spread 自 current）
  if (patch.groups !== undefined) next.groups = sanitizeGroups(patch.groups)

  const file = settingsFile()
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}