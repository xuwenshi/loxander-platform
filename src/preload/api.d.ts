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
  }
  versions: RuntimeVersions
}

declare global {
  interface Window {
    cms: CmsApi
  }
}