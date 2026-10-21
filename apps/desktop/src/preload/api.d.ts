/** preload 通过 contextBridge 暴露的白名单 API 类型（renderer 与 preload 共用） */

/** UI 主题模式：同时决定布局形态与配色（renderer 写到 <html data-mode>） */
export type ThemeMode = 'soft' | 'dashboard' | 'writing' | 'developer'
/** 明暗外观：与主题模式正交（renderer 写到 <html data-scheme>） */
export type ColorScheme = 'light' | 'dark'
/** 编辑器布局偏好（P2 编辑模式使用） */
export type EditorLayout = 'split' | 'editor' | 'preview'

export interface Settings {
  workspaceRoot: string
  proxy: string
  remote: string
  branch: string
  preflightWithBuild: boolean
  deployProvider: 'github' | 'vercel'
  repository: string
  vercelToken: string
  vercelProjectId: string
  productionUrl: string
  /** ---- UI 偏好：存 <userData>/settings.json，与凭据同处，不随仓库分发 ---- */
  themeMode: ThemeMode
  colorScheme: ColorScheme
  sidebarCollapsed: boolean
  editorLayout: EditorLayout
  /**
   * 内容虚拟分组（文件夹）：CMS 侧归类元数据，只存 <userData>/settings.json。
   * 不写进博客仓库、不改磁盘结构（博客读取内容不递归，建子目录会让文章不上站）。
   */
  groups: GroupStore
  /** ---- 本地实时预览 + 线上自动发布：默认都开启 ---- */
  /** 内容保存 / content/ 变化后自动「预检 → 提交 → 推送 → 回读部署」 */
  autoPublish: boolean
  /** 自动发布 debounce 窗口（毫秒） */
  autoPublishDebounceMs: number
  /** 应用启动后自动拉起本地预览 dev server */
  previewAutoStart: boolean
  /** 本地预览 dev server 端口（占用时 Next 会自增，实际以回传为准） */
  previewPort: number
  /** 运行 Next 的 node 可执行文件；空 = 用 Electron 内置 node */
  nodePath: string
}

export type CmsResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; hint?: string; detail?: unknown }

export interface ContentEntry {
  slug: string
  file: string
  title: string | null
  date: string | null
  draft: boolean
  size: number
  mtimeMs: number
  parseError: string | null
  /** 所属虚拟分组 id；null = 未分组 */
  groupId: string | null
}

export interface SectionSummary {
  section: string
  dir: string
  count: number
  entries: ContentEntry[]
  /** 该分区的虚拟分组（文件夹） */
  groups: ContentGroup[]
}

/** 一个虚拟分组（文件夹）：只存在于 CMS 侧，不落进博客仓库 */
export interface ContentGroup {
  id: string
  name: string
}

/** 分组元数据：分组表（分区 → 分组）+ 归属表（`<section>/<slug>` → groupId） */
export interface GroupStore {
  groups: Record<string, ContentGroup[]>
  assignments: Record<string, string>
}

export interface ContentListPayload {
  workspaceRoot: string
  sections: SectionSummary[]
}

/** 文件指纹（乐观锁）：保存时回传读取时的值，不一致即视为冲突 */
export interface FileFingerprint {
  mtimeMs: number
  size: number
  sha256: string
}

export interface EntryDocument {
  section: string
  slug: string
  file: string
  fingerprint: FileFingerprint
  frontmatterRaw: string
  body: string
  data: Record<string, unknown>
  dataError: string | null
  text: string
}

export type FrontmatterPatch = Record<string, unknown>

export interface PatchChange {
  key: string
  kind: 'update' | 'add' | 'remove'
  from: string | null
  to: string | null
}

export interface DiffLine {
  type: 'equal' | 'insert' | 'delete'
  text: string
  aLine: number | null
  bLine: number | null
}

export interface DiffSummary {
  added: number
  removed: number
  frontmatterFormatOnly: boolean
}

export interface SaveResult {
  file: string
  fingerprint: FileFingerprint
  changes: PatchChange[]
  skipped: string[]
  backupPath: string | null
  diff: DiffLine[]
  summary: DiffSummary
  changed: boolean
}

export interface DirtyDiffResult {
  diff: DiffLine[]
  summary: DiffSummary
  changes: PatchChange[]
  skipped: string[]
  text: string
}

export interface Issue {
  level: 'block' | 'warn'
  field?: string
  message: string
  hint?: string
}

export interface FileValidation {
  section: string
  slug: string
  file: string
  blocking: Issue[]
  warnings: Issue[]
}

export interface WorkspaceValidation {
  files: FileValidation[]
  blockingCount: number
  warningCount: number
}

export type FieldKind = 'string' | 'date' | 'enum' | 'boolean' | 'number' | 'stringArray' | 'milestones'

export interface FieldSpec {
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  options?: string[]
  min?: number
  max?: number
  clamp?: boolean
  help?: string
  fallback?: number
}

export interface SectionSchema {
  section: string
  fields: FieldSpec[]
  order: string[]
  minCount: number
}

export interface RuntimeVersions {
  electron: string
  chrome: string
  node: string
}

/** ---- Git 闸门（P2） ---- */

export interface GitFileStatus {
  path: string
  index: string
  workingDir: string
  staged: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  tracking: string | null
  ahead: number
  behind: number
  clean: boolean
  files: GitFileStatus[]
}

export interface GitDiffFile {
  path: string
  insertions: number
  deletions: number
  binary: boolean
}

export interface GitDiff {
  stat: string
  text: string
  files: GitDiffFile[]
  truncated: boolean
}

export type PreflightLevel = 'block' | 'warn' | 'info'

export interface PreflightIssue {
  level: PreflightLevel
  code: string
  message: string
  hint?: string
  file?: string
  field?: string
}

export interface ChangedFile extends GitFileStatus {
  isContent: boolean
}

export interface PreflightReport {
  ok: boolean
  generatedAt: string
  workspaceRoot: string
  remote: string
  expectedBranch: string
  git: GitStatus
  changedFiles: ChangedFile[]
  contentFiles: string[]
  otherFiles: string[]
  suggestedMessage: string
  issues: PreflightIssue[]
  blocking: PreflightIssue[]
  warnings: PreflightIssue[]
  infos: PreflightIssue[]
  validation: WorkspaceValidation
  sectionCounts: Record<string, number>
}

export type PublishPhase = 'idle' | 'committed-not-pushed' | 'pushed'

export interface PublishError {
  code: string
  message: string
  hint?: string
}

export interface PublishState {
  phase: PublishPhase
  commitSha: string | null
  branch: string
  remote: string
  message: string | null
  files: string[]
  pushed: boolean
  error: PublishError | null
  updatedAt: string
}

export interface PullResult extends GitStatus {
  summary: string
}

/** ---- 内容管理闭环（P3） ---- */

export interface CreateEntryResult {
  section: string
  slug: string
  file: string
  fingerprint: FileFingerprint
}

export interface DeleteEntryResult {
  section: string
  slug: string
  file: string
  backupPath: string
  remaining: number
}

export interface RenameReference {
  section: string
  slug: string
  file: string
  field: string
  value: string
}

export interface RenameEntryResult {
  section: string
  from: string
  to: string
  file: string
  previousFile: string
  references: RenameReference[]
  staleUrl: string | null
}

export interface CoverOption {
  path: string
  file: string
}

/** ---- 部署回读（P4） ---- */

export type DeployProvider = 'github' | 'vercel'

export type DeployState = 'pending' | 'building' | 'ready' | 'error' | 'unknown'

export interface DeployStatus {
  provider: DeployProvider
  sha: string
  state: DeployState
  /** 提供方原始状态串（GitHub state / Vercel readyState） */
  rawState: string
  url: string | null
  targetUrl: string | null
  inspectorUrl: string | null
  description: string | null
  message: string | null
  attempts: number
  verified: boolean
  verifyStatus: number | null
  updatedAt: string
  error: { code: string; message: string } | null
}

export interface ReadyPayload {
  bridge: true
  versions: RuntimeVersions
  location: string
  /** 分区计数快照，便于自检输出可读的链路证据 */
  contentSummary?: Record<string, number>
}

/** ---- 外部改动感知：主进程监听 content/ 后推送的事件 ---- */
export interface ContentChangeEvent {
  /** 事件所属工作区根：renderer 用它丢弃切换工作区后的过期事件 */
  workspaceRoot: string
  /** 变更文件的 workspace 相对路径（POSIX，如 content/blog/demo.md，已去重排序） */
  paths: string[]
  /** 触发时间（ISO 字符串） */
  at: string
}

/** ---- 本地实时预览（A）：dev server 状态 ---- */

export type PreviewState = 'stopped' | 'starting' | 'ready' | 'error'

export interface PreviewStatus {
  state: PreviewState
  /** dev server 进程 pid（未运行为 null） */
  pid: number | null
  /** 真实 origin（如 http://localhost:3210），未解析到为 null */
  origin: string | null
  /** 实际端口（Next 自增后以回传为准） */
  port: number | null
  /** 错误/提示信息 */
  message: string | null
  /** 就绪后主动 HTTP 探测的结果：null = 未探测/不适用，true = 页面可访问 */
  verified: boolean | null
  /** 探测拿到的 HTTP 状态码（无响应时为 null） */
  verifyStatus: number | null
}

/** ---- 线上自动发布（B）：一次决策/结果事件（UI 必须显式展示，绝不静默） ---- */

export interface AutoPublishEvent {
  kind: 'skipped' | 'published' | 'error'
  /** 跳过原因 / 错误信息 */
  reason: string | null
  /** 本次实际参与提交的文件 */
  files: string[]
  /** 提交消息（发布成功时有值） */
  commitMessage: string | null
  /** 发布后的状态（发布成功时有值） */
  state: PublishState | null
  at: string
}

export interface CmsApi {
  settings: {
    get(): Promise<CmsResult<Settings>>
    set(patch: Partial<Settings>): Promise<CmsResult<Settings>>
    pickWorkspace(): Promise<CmsResult<{ canceled: boolean; settings: Settings }>>
  }
  content: {
    list(section?: string): Promise<CmsResult<ContentListPayload>>
    schema(): Promise<CmsResult<Record<string, SectionSchema>>>
    read(section: string, slug: string): Promise<CmsResult<EntryDocument>>
    patchFrontmatter(payload: {
      section: string
      slug: string
      patch: FrontmatterPatch
      body?: string
      expected: FileFingerprint
      force?: boolean
    }): Promise<CmsResult<SaveResult>>
    saveBody(payload: {
      section: string
      slug: string
      body: string
      expected: FileFingerprint
      force?: boolean
    }): Promise<CmsResult<SaveResult>>
    dirtyDiff(payload: {
      section: string
      slug: string
      patch?: FrontmatterPatch
      body?: string
    }): Promise<CmsResult<DirtyDiffResult>>
    validate(): Promise<CmsResult<WorkspaceValidation>>
    covers(): Promise<CmsResult<CoverOption[]>>
    create(payload: {
      section: string
      slug: string
      title?: string
      date?: string
    }): Promise<CmsResult<CreateEntryResult>>
    delete(payload: { section: string; slug: string }): Promise<CmsResult<DeleteEntryResult>>
    rename(payload: {
      section: string
      slug: string
      nextSlug: string
    }): Promise<CmsResult<RenameEntryResult>>
  }
  /** 内容虚拟分组（文件夹）：每个分区各自一份分组，只写 userData，不碰博客仓库 */
  groups: {
    create(payload: { section: string; name: string }): Promise<CmsResult<GroupStore>>
    rename(payload: { section: string; id: string; name: string }): Promise<CmsResult<GroupStore>>
    /** 删除文件夹只取消归类（条目回到「未分组」），不会删除任何 .md */
    remove(payload: { section: string; id: string }): Promise<CmsResult<GroupStore>>
    /** groupId 传 null = 移出分组 */
    assign(payload: {
      section: string
      slug: string
      groupId: string | null
    }): Promise<CmsResult<GroupStore>>
  }
  git: {
    status(): Promise<CmsResult<GitStatus>>
    diff(scope?: { staged?: boolean; files?: string[] }): Promise<CmsResult<GitDiff>>
    preflight(): Promise<CmsResult<PreflightReport>>
    pull(): Promise<CmsResult<PullResult>>
  }
  publish: {
    state(): Promise<CmsResult<PublishState>>
    run(payload: {
      message: string
      files: string[]
      confirmed: boolean
    }): Promise<CmsResult<PublishState>>
    retryPush(): Promise<CmsResult<PublishState>>
    /** 一键回滚（P5 可选）：对上一次发布生成反向提交（git revert），需 confirmed=true */
    revert(payload?: { confirmed?: boolean; push?: boolean }): Promise<CmsResult<PublishState>>
    clear(): Promise<CmsResult<PublishState>>
    /** 开启 / 关闭自动发布（写 settings.json） */
    setAuto(auto: boolean): Promise<CmsResult<Settings>>
    /** 暂停 / 恢复自动发布：renderer 检测到冲突或外部改动时置位，避免自动改动被级联发布 */
    autoHold(hold: boolean): Promise<CmsResult<{ hold: boolean }>>
  }
  /** 本地实时预览（A）：在主进程拉起 next dev，用 <webview> 加载真实页面 */
  preview: {
    start(): Promise<CmsResult<PreviewStatus>>
    stop(): Promise<CmsResult<PreviewStatus>>
    restart(): Promise<CmsResult<PreviewStatus>>
    status(): Promise<CmsResult<PreviewStatus>>
    /** dev server 的 stdout/stderr 环形缓冲日志（供「查看日志」） */
    logs(): Promise<CmsResult<string>>
  }
  deploy: {
    /** wait=true（默认）轮询到就绪/失败/超时；wait=false 只查询一次 */
    status(payload?: {
      provider?: DeployProvider
      sha?: string
      wait?: boolean
    }): Promise<CmsResult<DeployStatus>>
  }
  runtime: {
    ready(
      payload: ReadyPayload
    ): Promise<CmsResult<{ acknowledged: boolean; selfcheck: boolean; appVersion: string }>>
    /** 订阅 content/ 目录的外部改动；返回退订函数（组件卸载时必须调用，避免监听泄漏） */
    onContentChanged(cb: (event: ContentChangeEvent) => void): () => void
    /** 订阅预览 dev server 的状态变化；返回退订函数 */
    onPreviewEvent(cb: (status: PreviewStatus) => void): () => void
    /** 订阅「自动发布已推送」后的发布状态（renderer 据此刷新并轮询部署） */
    onPublishChanged(cb: (state: PublishState) => void): () => void
    /** 订阅自动发布后主进程的一次部署回读结果 */
    onDeployChanged(cb: (status: DeployStatus) => void): () => void
    /** 订阅自动发布的决策/结果（跳过原因、实际提交清单） */
    onAutoPublishEvent(cb: (event: AutoPublishEvent) => void): () => void
  }
  versions: RuntimeVersions
}

declare global {
  interface Window {
    cms: CmsApi
  }
}