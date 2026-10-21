import { create } from 'zustand'
import type {
  AutoPublishEvent,
  ColorScheme,
  ContentChangeEvent,
  CoverOption,
  DeployProvider,
  DeployState,
  DeployStatus,
  DirtyDiffResult,
  EditorLayout,
  EntryDocument,
  GitStatus,
  Issue,
  PreflightReport,
  PreviewStatus,
  PublishState,
  SectionSchema,
  SectionSummary,
  ThemeMode
} from '../../preload/api'
import { buildBaseline, buildPatch } from './formValue'
import { applyColorScheme, applyThemeMode, metaOf } from './theme'

/** 部署状态 → 中文标签（仅供 UI 展示） */
export function deployStateLabel(state: DeployState): string {
  switch (state) {
    case 'pending':
      return '排队中'
    case 'building':
      return '构建中'
    case 'ready':
      return '已就绪'
    case 'error':
      return '失败'
    default:
      return '未知'
  }
}

/**
 * renderer 状态（Zustand，轻量）：
 * 内容清单 + 当前编辑条目的「表单值 / 基线 / 正文」三份状态，脏值由二者差集派生，
 * 保存时只把这些差集作为字段级 patch 发给主进程。
 */

export interface ConflictState {
  message: string
  hint?: string
  diskText: string
}

/** 外部改动提示态：仅在「当前文件被外部修改且缓冲区有改动」时展示 */
export interface ExternalChangeState {
  /** 本次事件涉及的 workspace 相对路径（POSIX） */
  paths: string[]
  at: string
}

interface CmsState {
  bridgeOk: boolean
  workspaceRoot: string
  sections: SectionSummary[]
  schemas: Record<string, SectionSchema>
  activeSection: string
  activeSlug: string | null

  doc: EntryDocument | null
  fields: Record<string, unknown>
  baseline: Record<string, unknown>
  body: string
  baselineBody: string

  preview: DirtyDiffResult | null
  conflict: ConflictState | null
  /** 当前打开的文件被外部修改，且缓冲区有改动时置位（提供重新载入 / 保留改动两种动作） */
  externalChange: ExternalChangeState | null
  workspaceIssues: { blocking: Issue[]; warnings: Issue[] }
  status: string
  error: string | null
  busy: boolean
  /** public/ 下的 .svg 候选（封面下拉） */
  covers: CoverOption[]

  /** ---- UI 偏好（P1）：持久化在 <userData>/settings.json，与凭据同处 ---- */
  themeMode: ThemeMode
  colorScheme: ColorScheme
  sidebarCollapsed: boolean
  editorLayout: EditorLayout

  /** ---- Git 闸门 / 发布（P2） ---- */
  report: PreflightReport | null
  gitStatus: GitStatus | null
  publishState: PublishState | null
  publishMessage: string
  /** 用户在确认卡中勾选的文件清单（默认只勾选 content/ 下的改动） */
  publishFiles: string[]
  publishConfirmed: boolean
  publishing: boolean

  /** ---- 部署回读（P4） ---- */
  deployStatus: DeployStatus | null
  deploying: boolean
  deployProvider: DeployProvider

  /** ---- 本地实时预览（A）：把真实博客页面内嵌在右侧第 4 列 ---- */
  previewVisible: boolean
  previewStatus: PreviewStatus
  /** 期望的预览端口（落盘 settings.previewPort；被占用时主进程自动向后找空闲端口） */
  previewPort: number
  /** 保存 / 内容变更后自增；PreviewPane 监听到即 reloadIgnoringCache() 刷新 */
  previewReloadToken: number
  previewLogs: string

  /** ---- 线上自动发布（B） ---- */
  autoPublish: boolean
  /** 最近一次自动发布的决策/结果（UI 必须显式展示，绝不静默） */
  autoPublishLast: AutoPublishEvent | null

  bootstrap: () => Promise<void>
  /** 订阅外部改动事件；返回退订函数（组件卸载时调用） */
  initWatcher: () => () => void
  pickWorkspace: () => Promise<void>
  setThemeMode: (mode: ThemeMode) => Promise<void>
  setColorScheme: (scheme: ColorScheme) => Promise<void>
  setEditorLayout: (layout: EditorLayout) => Promise<void>
  toggleSidebar: () => void
  selectSection: (section: string) => void
  openEntry: (slug: string) => Promise<void>
  closeEntry: () => void
  setField: (key: string, value: unknown) => void
  setBody: (value: string) => void
  currentPatch: () => Record<string, unknown>
  isDirty: () => boolean
  runPreview: () => Promise<void>
  save: (force?: boolean) => Promise<void>
  discard: () => void
  reloadFromDisk: () => Promise<void>
  /** 保留我方的未保存改动，仅收起外部改动横幅（后续保存会在冲突时再裁决） */
  keepMyChanges: () => void
  /** 处理主进程推送的外部改动事件（清单刷新 + 当前文件跟随/提示） */
  handleContentChanged: (event: ContentChangeEvent) => Promise<void>
  validateWorkspace: () => Promise<void>
  refreshList: () => Promise<void>
  createEntry: (slug: string, title?: string) => Promise<void>
  removeEntry: (slug: string) => Promise<void>
  renameEntry: (slug: string, nextSlug: string) => Promise<void>

  /** ---- 虚拟分组（文件夹）：均作用于当前分区 ---- */
  createGroup: (name: string) => Promise<void>
  renameGroup: (id: string, name: string) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  assignEntry: (slug: string, groupId: string | null) => Promise<void>

  runPreflight: () => Promise<void>
  loadPublishState: () => Promise<void>
  togglePublishFile: (path: string) => void
  setPublishMessage: (message: string) => void
  setPublishConfirmed: (confirmed: boolean) => void
  runPublish: () => Promise<void>
  retryPublish: () => Promise<void>
  rollbackPublish: () => Promise<void>
  gitPull: () => Promise<void>
  resetPublish: () => Promise<void>

  setDeployProvider: (provider: DeployProvider) => void
  runDeployStatus: (wait?: boolean) => Promise<void>
  clearDeployStatus: () => void

  /** 订阅预览状态 / 自动发布 / 部署回读事件；返回退订函数（组件卸载时调用） */
  initPreview: () => () => void
  openPreview: () => void
  closePreview: () => void
  startPreview: () => Promise<void>
  stopPreview: () => Promise<void>
  restartPreview: () => Promise<void>
  refreshPreviewLogs: () => Promise<void>
  /** 设置预览端口并落盘；若预览正在运行，主进程会停旧起新（换到新端口） */
  setPreviewPort: (port: number) => Promise<void>
  setAutoPublish: (auto: boolean) => Promise<void>
  /** 处理主进程推送的自动发布事件（跳过原因 / 实际提交清单） */
  handleAutoPublishEvent: (event: AutoPublishEvent) => void
}

function errorText(res: { code: string; message: string; hint?: string }): string {
  return `${res.code}：${res.message}${res.hint ? `（${res.hint}）` : ''}`
}

/**
 * 编辑器缓冲区统一用 LF（与 CodeMirror 的内部模型一致）。
 * 磁盘上可能是 CRLF，若不归一：打开文件时编辑器会把 CRLF 归一成 LF，
 * 与基线一比就凭空变成「有未保存改动」。写回时由主进程按原文件的换行符还原。
 */
function toEditorText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function emptyState() {
  return {
    doc: null,
    fields: {} as Record<string, unknown>,
    baseline: {} as Record<string, unknown>,
    body: '',
    baselineBody: '',
    preview: null,
    conflict: null,
    externalChange: null,
    error: null
  }
}

/** 当前条目的 workspace 相对路径（POSIX），用于与 watcher 事件里的路径比对 */
export function currentEntryPath(section: string, slug: string): string {
  return `content/${section}/${slug}.md`
}

export const useCms = create<CmsState>((set, get) => {
  /**
   * 冲突 / 外部改动期间暂停自动发布：只要任一提示态存在就 hold，
   * 二者都清掉才恢复 —— 避免我方尚未裁决的改动被自动提交并级联发布。
   */
  const syncAutoHold = (): void => {
    const { conflict, externalChange } = get()
    void window.cms?.publish.autoHold(Boolean(conflict || externalChange))
  }

  return {
  bridgeOk: false,
  workspaceRoot: '',
  sections: [],
  schemas: {},
  activeSection: '',
  activeSlug: null,
  ...emptyState(),
  workspaceIssues: { blocking: [], warnings: [] },
  status: '正在初始化…',
  busy: false,
  covers: [],
  themeMode: 'soft',
  colorScheme: 'dark',
  sidebarCollapsed: false,
  editorLayout: 'split',
  report: null,
  gitStatus: null,
  publishState: null,
  publishMessage: '',
  publishFiles: [],
  publishConfirmed: false,
  publishing: false,
  deployStatus: null,
  deploying: false,
  deployProvider: 'github',
  previewVisible: false,
  previewStatus: {
    state: 'stopped',
    pid: null,
    origin: null,
    port: null,
    message: null,
    verified: null,
    verifyStatus: null
  },
  previewPort: 3210,
  previewReloadToken: 0,
  previewLogs: '',
  autoPublish: true,
  autoPublishLast: null,

  async bootstrap() {
    const cms = window.cms
    if (!cms) {
      set({ bridgeOk: false, error: 'window.cms 不存在：preload 未加载或被沙箱策略拦截' })
      return
    }
    set({ bridgeOk: true, busy: true, error: null })

    const [listRes, schemaRes, coverRes, settingsRes] = await Promise.all([
      cms.content.list(),
      cms.content.schema(),
      cms.content.covers(),
      cms.settings.get()
    ])
    if (!listRes.ok) {
      set({ busy: false, error: errorText(listRes) })
      return
    }
    if (!schemaRes.ok) {
      set({ busy: false, error: errorText(schemaRes) })
      return
    }

    const sections = listRes.data.sections
    // UI 偏好随初始化一起落地，避免先渲染默认主题再闪一下
    const themeMode = settingsRes.ok ? settingsRes.data.themeMode : 'soft'
    const colorScheme = settingsRes.ok ? settingsRes.data.colorScheme : 'dark'
    if (settingsRes.ok) {
      applyThemeMode(themeMode)
      applyColorScheme(colorScheme)
    }
    set({
      sections,
      schemas: schemaRes.data,
      workspaceRoot: listRes.data.workspaceRoot,
      activeSection: get().activeSection || sections[0]?.section || '',
      covers: coverRes.ok ? coverRes.data : [],
      deployProvider: settingsRes.ok ? settingsRes.data.deployProvider : 'github',
      themeMode,
      colorScheme,
      sidebarCollapsed: settingsRes.ok ? settingsRes.data.sidebarCollapsed : false,
      editorLayout: settingsRes.ok ? settingsRes.data.editorLayout : 'split',
      autoPublish: settingsRes.ok ? settingsRes.data.autoPublish : true,
      previewPort: settingsRes.ok ? settingsRes.data.previewPort : 3210,
      busy: false,
      status: `已加载 ${sections.reduce((sum, item) => sum + item.count, 0)} 篇内容`
    })

    /**
     * 启动即展开预览列（用户确认的交互）：打开软件就能看到预览是否正常。
     * 只在已配置工作区时展开——否则会展开一个必然报错的空面板；
     * 非 soft 模式下 PreviewPane 本来就是 hidden，这里不强制切模式。
     */
    if (listRes.data.workspaceRoot) set({ previewVisible: true })

    // 自检模式据此判定链路打通（含分区计数）
    await cms.runtime.ready({
      bridge: true,
      versions: cms.versions,
      location: window.location.href,
      contentSummary: Object.fromEntries(sections.map((item) => [item.section, item.count]))
    })
  },

  /**
   * 订阅 content/ 的外部改动。preload 未暴露该通道时（旧版）安全降级为空订阅。
   * 返回退订函数，交给 React effect 的 cleanup 调用，避免热更新时重复注册。
   */
  initWatcher() {
    const cms = window.cms
    if (!cms?.runtime?.onContentChanged) return () => {}
    return cms.runtime.onContentChanged((event) => {
      void get().handleContentChanged(event)
    })
  },

  /**
   * 订阅预览状态 / 自动发布 / 部署回读三类事件，并主动补拉一次当前预览状态。
   * 与 initWatcher 一样返回退订函数（老版本 preload 缺通道时逐项安全降级）。
   */
  initPreview() {
    const cms = window.cms
    if (!cms) return () => {}
    const subs: Array<(() => void) | undefined> = [
      cms.runtime?.onPreviewEvent?.((status) => set({ previewStatus: status })),
      cms.runtime?.onPublishChanged?.((state) => set({ publishState: state })),
      cms.runtime?.onDeployChanged?.((status) => set({ deployStatus: status })),
      cms.runtime?.onAutoPublishEvent?.((event) => get().handleAutoPublishEvent(event))
    ]
    // 面板可能在 dev server 就绪之后才打开：补拉一次，避免显示成「未启动」
    void cms.preview?.status?.().then((res) => {
      if (res.ok) set({ previewStatus: res.data })
    })
    return () => {
      for (const off of subs) off?.()
    }
  },

  /** 展开预览列；若 dev server 还没起来就按需拉起（已在运行则只展开，不重复启动） */
  openPreview() {
    set({ previewVisible: true })
    const state = get().previewStatus.state
    if (state === 'stopped' || state === 'error') void get().startPreview()
  },

  closePreview() {
    // 只隐藏面板，不停 dev server：再次展开可秒显示（stop 交给显式按钮/退出）
    set({ previewVisible: false })
  },

  async startPreview() {
    const cms = window.cms
    if (!cms) return
    set({ previewStatus: { ...get().previewStatus, state: 'starting', message: '正在启动本地预览…' } })
    const res = await cms.preview.start()
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ previewStatus: res.data, error: null, status: `本地预览已就绪：${res.data.origin ?? ''}` })
  },

  async stopPreview() {
    const cms = window.cms
    if (!cms) return
    const res = await cms.preview.stop()
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ previewStatus: res.data, status: '本地预览已停止' })
  },

  /** 兜底刷新：重启 dev server（约 6.5s）——用于 reloadIgnoringCache 仍拿到陈旧内容的极少数情形 */
  async restartPreview() {
    const cms = window.cms
    if (!cms) return
    set({ previewStatus: { ...get().previewStatus, state: 'starting', message: '正在重启本地预览…' } })
    const res = await cms.preview.restart()
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ previewStatus: res.data, error: null, status: `本地预览已重启：${res.data.origin ?? ''}` })
  },

  async refreshPreviewLogs() {
    const cms = window.cms
    if (!cms) return
    const res = await cms.preview.logs()
    if (res.ok) set({ previewLogs: res.data })
  },

  /** 自动发布开关：乐观切换并落盘 settings.json，落盘失败即回滚 */
  async setAutoPublish(auto) {
    const cms = window.cms
    if (!cms) return
    const previous = get().autoPublish
    if (auto === previous) return
    set({ autoPublish: auto })
    const res = await cms.publish.setAuto(auto)
    if (!res.ok) {
      set({ autoPublish: previous, error: errorText(res) })
      return
    }
    set({
      autoPublish: res.data.autoPublish,
      status: auto ? '已开启自动发布：内容保存后将自动提交并推送（1–3 分钟上线）' : '已关闭自动发布'
    })
  },

  handleAutoPublishEvent(event) {
    set({ autoPublishLast: event })
    // 发布成功的状态刷新走主进程另外广播的 publish:changed / publish:deployChanged，这里只补状态栏
    if (event.kind === 'published') {
      set({ status: event.commitMessage ? `自动发布：${event.commitMessage}` : '自动发布完成' })
    } else if (event.kind === 'error') {
      set({ status: `自动发布失败：${event.reason ?? '未知错误'}` })
    } else if (event.kind === 'skipped') {
      set({ status: `自动发布已跳过：${event.reason ?? '条件不满足'}` })
    }
  },

  /**
   * 外部改动处理：
   * 1) 先刷新清单（新增/删除/改名都会反映到侧栏）；
   * 2) 若变更的正是当前打开的文件——缓冲区干净就静默跟随磁盘，
   *    有未保存改动则「绝不覆盖」，只置提示态交给用户裁决。
   */
  async handleContentChanged(event) {
    const cms = window.cms
    if (!cms) return
    // 工作区切换后可能收到旧根的事件，直接丢弃
    if (get().workspaceRoot && event.workspaceRoot && event.workspaceRoot !== get().workspaceRoot) return

    await get().refreshList()
    // 内容有任何变化（CMS 自己保存或其他程序改的）都让预览刷新一次
    set({ previewReloadToken: get().previewReloadToken + 1 })

    const { activeSection, activeSlug, doc } = get()
    if (!doc || !activeSlug) return
    if (!event.paths.includes(currentEntryPath(activeSection, activeSlug))) return

    if (get().isDirty()) {
      set({
        externalChange: { paths: event.paths, at: event.at },
        status: '检测到外部改动：当前文件已被其他程序修改'
      })
      syncAutoHold()
      return
    }

    // 缓冲区干净 → 静默重新读入（沿用 LF 归一，避免误判脏值）
    const res = await cms.content.read(activeSection, activeSlug)
    if (!res.ok) {
      // 文件可能被外部删除或改名，此时无法静默跟随
      set({
        externalChange: { paths: event.paths, at: event.at },
        status: '检测到外部改动：当前文件可能已被删除或重命名'
      })
      syncAutoHold()
      return
    }
    // 磁盘内容与本机基线一致（例如刚由本 CMS 保存触发的事件）：无需跟随，也不打扰状态栏
    if (res.data.fingerprint.sha256 === doc.fingerprint.sha256) {
      set({ externalChange: null })
      syncAutoHold()
      return
    }
    const schema = get().schemas[activeSection]
    const baseline = schema ? buildBaseline(schema, res.data.data) : {}
    const bufferBody = toEditorText(res.data.body)
    set({
      doc: res.data,
      baseline,
      fields: { ...baseline },
      body: bufferBody,
      baselineBody: bufferBody,
      preview: null,
      externalChange: null,
      error: null,
      status: '已自动跟随磁盘上的外部改动'
    })
    syncAutoHold()
  },

  /** 手动选择博客仓库根目录（打包安装后没有同级 my-blog，必须能手动指定） */
  async pickWorkspace() {
    const cms = window.cms
    if (!cms) return
    const res = await cms.settings.pickWorkspace()
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    if (res.data.canceled) {
      set({ status: '已取消选择工作区' })
      return
    }
    set({ workspaceRoot: res.data.settings.workspaceRoot })
    await get().bootstrap()
  },

  /**
   * 主题切换：先乐观改 <html data-mode>（只换 CSS 变量取值，不重挂载组件），
   * 再落盘 settings.json；落盘失败则回滚，保证 UI 与磁盘一致。
   */
  async setThemeMode(mode) {
    const previous = get().themeMode
    if (mode === previous) return
    set({ themeMode: mode })
    applyThemeMode(mode)

    const cms = window.cms
    if (!cms) return
    const res = await cms.settings.set({ themeMode: mode })
    if (!res.ok) {
      set({ themeMode: previous, error: errorText(res) })
      applyThemeMode(previous)
      return
    }
    set({ status: `已切换到「${metaOf(mode).label}」模式` })
  },

  /** 明暗切换：同样只改 <html data-scheme>，落盘失败即回滚 */
  async setColorScheme(scheme) {
    const previous = get().colorScheme
    if (scheme === previous) return
    set({ colorScheme: scheme })
    applyColorScheme(scheme)

    const cms = window.cms
    if (!cms) return
    const res = await cms.settings.set({ colorScheme: scheme })
    if (!res.ok) {
      set({ colorScheme: previous, error: errorText(res) })
      applyColorScheme(previous)
      return
    }
    set({ status: `已切换到${scheme === 'light' ? '浅色' : '深色'}外观` })
  },

  /**
   * 编辑区布局（编辑器 / 分栏 / 预览）：本地即时生效并落盘 settings.json。
   * 只切 data-layout 与可见性，编辑器组件不卸载，撤销栈与光标不丢。
   */
  async setEditorLayout(layout) {
    const previous = get().editorLayout
    if (layout === previous) return
    set({ editorLayout: layout })

    const cms = window.cms
    if (!cms) return
    const res = await cms.settings.set({ editorLayout: layout })
    if (!res.ok) {
      set({ editorLayout: previous, error: errorText(res) })
      return
    }
    set({
      status:
        layout === 'editor'
          ? '编辑区布局：仅编辑器'
          : layout === 'split'
            ? '编辑区布局：编辑 + 预览分栏'
            : '编辑区布局：仅预览'
    })
  },

  toggleSidebar() {
    const next = !get().sidebarCollapsed
    set({ sidebarCollapsed: next })
    void window.cms?.settings.set({ sidebarCollapsed: next })
  },

  /**
   * 预览端口：落盘 settings.previewPort。
   * 主进程侧 devServerFingerprint 含 previewPort，且 settings:set 之后会
   * restartPreviewIfRunning()，所以预览在跑时会自动停旧起新、换到新端口。
   */
  async setPreviewPort(port) {
    const next = Math.max(1024, Math.min(65_535, Math.round(port)))
    if (!Number.isFinite(next)) return
    const previous = get().previewPort
    if (next === previous) return

    set({ previewPort: next })
    const cms = window.cms
    if (!cms) return
    const res = await cms.settings.set({ previewPort: next })
    if (!res.ok) {
      set({ previewPort: previous, error: errorText(res) })
      return
    }
    set({ previewPort: res.data.previewPort, status: `预览端口已设为 ${res.data.previewPort}` })
  },

  selectSection(section) {
    if (get().isDirty()) {
      const ok = window.confirm('当前条目有未保存改动，切换分区将丢弃这些改动。继续？')
      if (!ok) return
    }
    set({ activeSection: section, activeSlug: null, ...emptyState() })
    syncAutoHold()
  },

  async openEntry(slug) {
    const cms = window.cms
    if (!cms) return
    if (get().isDirty()) {
      const ok = window.confirm('当前条目有未保存改动，切换将丢弃这些改动。继续？')
      if (!ok) return
    }
    const section = get().activeSection
    const res = await cms.content.read(section, slug)
    if (!res.ok) {
      set({ error: errorText(res), status: '' })
      return
    }
    const schema = get().schemas[section]
    const baseline = schema ? buildBaseline(schema, res.data.data) : {}
    // 基线正文与缓冲区都用 LF，脏值判定才不被换行符差异污染
    const bufferBody = toEditorText(res.data.body)
    set({
      activeSlug: slug,
      doc: res.data,
      baseline,
      fields: { ...baseline },
      body: bufferBody,
      baselineBody: bufferBody,
      preview: null,
      conflict: null,
      externalChange: null,
      error: null,
      status: `已打开 ${section}/${slug}`
    })
    syncAutoHold()
  },

  closeEntry() {
    if (get().isDirty()) {
      const ok = window.confirm('当前条目有未保存改动，关闭将丢弃这些改动。继续？')
      if (!ok) return
    }
    set({ activeSlug: null, ...emptyState() })
    syncAutoHold()
  },

  setField(key, value) {
    set({ fields: { ...get().fields, [key]: value }, preview: null })
  },

  setBody(value) {
    set({ body: value, preview: null })
  },

  currentPatch() {
    const { schemas, activeSection, fields, baseline } = get()
    const schema = schemas[activeSection]
    if (!schema) return {}
    return buildPatch(schema, fields, baseline)
  },

  isDirty() {
    const { doc, body, baselineBody } = get()
    if (!doc) return false
    return Object.keys(get().currentPatch()).length > 0 || body !== baselineBody
  },

  async runPreview() {
    const cms = window.cms
    const { activeSection, activeSlug, doc, body, baselineBody } = get()
    if (!cms || !activeSlug || !doc) return
    const patch = get().currentPatch()
    const res = await cms.content.dirtyDiff({
      section: activeSection,
      slug: activeSlug,
      patch,
      body: body !== baselineBody ? body : undefined
    })
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ preview: res.data, error: null })
  },

  async save(force = false) {
    const cms = window.cms
    const { activeSection, activeSlug, doc, body, baselineBody } = get()
    if (!cms || !activeSlug || !doc) return
    const patch = get().currentPatch()
    const bodyChanged = body !== baselineBody
    if (!force && Object.keys(patch).length === 0 && !bodyChanged) {
      set({ status: '没有需要保存的改动' })
      return
    }
    set({ busy: true })
    const res = await cms.content.patchFrontmatter({
      section: activeSection,
      slug: activeSlug,
      patch,
      body: bodyChanged ? body : undefined,
      expected: doc.fingerprint,
      force
    })
    if (!res.ok) {
      set({ busy: false })
      if (res.code === 'CONFLICT') {
        const detail = res.detail as { diskText?: string } | undefined
        set({
          conflict: { message: res.message, hint: res.hint, diskText: detail?.diskText ?? '' },
          error: null
        })
        // 有未裁决的冲突 → 暂停自动发布，避免把「待裁决」的磁盘版本自动提交上线
        syncAutoHold()
        return
      }
      set({ error: errorText(res), status: '' })
      return
    }

    // 保存成功后重读，确保基线、指纹与磁盘严格一致
    const reloaded = await cms.content.read(activeSection, activeSlug)
    if (!reloaded.ok) {
      set({ busy: false, error: errorText(reloaded), status: '已保存，但重读失败，请手动刷新' })
      return
    }
    const schema = get().schemas[activeSection]
    const baseline = schema ? buildBaseline(schema, reloaded.data.data) : {}
    const bufferBody = toEditorText(reloaded.data.body)
    set({
      busy: false,
      doc: reloaded.data,
      baseline,
      fields: { ...baseline },
      body: bufferBody,
      baselineBody: bufferBody,
      conflict: null,
      preview: null,
      error: null,
      status:
        res.data.changed
          ? `已保存：改动 ${res.data.changes.map((change) => change.key).join(' / ') || '正文'}${
              res.data.backupPath ? '（已备份）' : ''
            }`
          : '没有需要写入的改动'
    })
    await get().refreshList()
    // 保存成功 → 解除 hold 并让本地预览刷新（watcher 也可能随后再触发一次，无害）
    set({ previewReloadToken: get().previewReloadToken + 1 })
    syncAutoHold()
  },

  discard() {
    const { baseline, baselineBody } = get()
    set({ fields: { ...baseline }, body: baselineBody, preview: null, conflict: null, error: null, status: '已放弃改动' })
    syncAutoHold()
  },

  async reloadFromDisk() {
    const { activeSection, activeSlug } = get()
    if (!activeSlug) return
    set({ conflict: null, externalChange: null })
    syncAutoHold()
    await get().openEntry(activeSlug)
    set({ status: `已重新加载磁盘版本（${activeSection}/${activeSlug}）` })
  },

  /**
   * 保留我方改动：只收起横幅，不动缓冲区。
   * 之后保存时乐观锁仍会拦住真实冲突，届时走「确认强制覆盖」流程。
   */
  keepMyChanges() {
    set({
      externalChange: null,
      status: '已保留你的改动；保存时若与磁盘冲突，可在冲突提示中选择强制覆盖'
    })
    syncAutoHold()
  },

  async validateWorkspace() {
    const cms = window.cms
    if (!cms) return
    const res = await cms.content.validate()
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    const blocking = res.data.files.flatMap((file) => file.blocking.map((issue) => ({ ...issue, field: `content/${file.section}/${file.slug}${issue.field ? `.${issue.field}` : ''}` })))
    const warnings = res.data.files.flatMap((file) => file.warnings.map((issue) => ({ ...issue, field: `content/${file.section}/${file.slug}${issue.field ? `.${issue.field}` : ''}` })))
    set({
      workspaceIssues: { blocking, warnings },
      error: null,
      status: `全仓校验完成：阻断 ${blocking.length} 项 / 告警 ${warnings.length} 项`
    })
  },

  async refreshList() {
    const cms = window.cms
    if (!cms) return
    const res = await cms.content.list()
    if (res.ok) set({ sections: res.data.sections })
  },

  async createEntry(slug, title) {
    const cms = window.cms
    if (!cms) return
    set({ busy: true, error: null })
    const res = await cms.content.create({ section: get().activeSection, slug, title })
    if (!res.ok) {
      set({ busy: false, error: errorText(res) })
      return
    }
    set({ busy: false, status: `已新建 content/${res.data.section}/${res.data.slug}.md` })
    await get().refreshList()
    await get().openEntry(res.data.slug)
  },

  async removeEntry(slug) {
    const cms = window.cms
    if (!cms) return
    const section = get().activeSection
    set({ busy: true, error: null })
    const res = await cms.content.delete({ section, slug })
    if (!res.ok) {
      set({ busy: false, error: errorText(res) })
      return
    }
    set({
      busy: false,
      activeSlug: null,
      ...emptyState(),
      status: `已删除 content/${section}/${slug}.md（已备份，剩 ${res.data.remaining} 篇）`
    })
    await get().refreshList()
  },

  async renameEntry(slug, nextSlug) {
    const cms = window.cms
    if (!cms) return
    const section = get().activeSection
    set({ busy: true, error: null })
    const res = await cms.content.rename({ section, slug, nextSlug })
    if (!res.ok) {
      set({ busy: false, error: errorText(res) })
      return
    }
    // 级联引用只提示、不自动改写；旧地址在站点无重定向会 404
    const notes: string[] = []
    if (res.data.references.length > 0) {
      notes.push(`${res.data.references.length} 处 article 引用仍指向旧 slug，需手动更新`)
    }
    if (res.data.staleUrl) notes.push(`旧地址 ${res.data.staleUrl} 将 404`)
    set({
      busy: false,
      activeSlug: null,
      ...emptyState(),
      status: `已重命名为 ${nextSlug}${notes.length > 0 ? '；' + notes.join('；') : ''}`
    })
    await get().refreshList()
    await get().openEntry(nextSlug)
  },

  /**
   * 虚拟分组（文件夹）：只写 <userData>/settings.json，不触碰博客仓库。
   * 每个动作成功后 refreshList，让「分组表 + 归属」一起从主进程重新拉取（单一数据来源）。
   */
  async createGroup(name) {
    const cms = window.cms
    if (!cms) return
    const res = await cms.groups.create({ section: get().activeSection, name })
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ error: null, status: `已新建文件夹「${name}」` })
    await get().refreshList()
  },

  async renameGroup(id, name) {
    const cms = window.cms
    if (!cms) return
    const res = await cms.groups.rename({ section: get().activeSection, id, name })
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ error: null, status: `文件夹已重命名为「${name}」` })
    await get().refreshList()
  },

  async deleteGroup(id) {
    const cms = window.cms
    if (!cms) return
    const res = await cms.groups.remove({ section: get().activeSection, id })
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ error: null, status: '文件夹已删除，原有条目回到「未分组」（未删除任何文件）' })
    await get().refreshList()
  },

  async assignEntry(slug, groupId) {
    const cms = window.cms
    if (!cms) return
    const { activeSection, sections } = get()
    const name = groupId
      ? (sections.find((item) => item.section === activeSection)?.groups.find((g) => g.id === groupId)?.name ?? '文件夹')
      : '未分组'
    const res = await cms.groups.assign({ section: activeSection, slug, groupId })
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ error: null, status: `已将 ${slug} 归入「${name}」` })
    await get().refreshList()
  },

  async runPreflight() {
    const cms = window.cms
    if (!cms) return
    set({ publishing: true, error: null })
    const [reportRes, stateRes] = await Promise.all([cms.git.preflight(), cms.publish.state()])
    if (!reportRes.ok) {
      set({ publishing: false, error: errorText(reportRes) })
      return
    }
    const report = reportRes.data
    set({
      publishing: false,
      report,
      gitStatus: report.git,
      publishState: stateRes.ok ? stateRes.data : null,
      // 默认只勾选 content/ 下的内容改动；非内容改动需人工显式勾选
      publishFiles: report.contentFiles,
      publishMessage: report.suggestedMessage,
      publishConfirmed: false,
      status: report.ok
        ? `预检通过：待发布 ${report.contentFiles.length} 个内容文件`
        : `预检未通过：${report.blocking.length} 项阻断`
    })
  },

  async loadPublishState() {
    const cms = window.cms
    if (!cms) return
    const res = await cms.publish.state()
    if (res.ok) set({ publishState: res.data })
  },

  togglePublishFile(path) {
    const selected = get().publishFiles
    set({
      publishFiles: selected.includes(path)
        ? selected.filter((item) => item !== path)
        : [...selected, path],
      publishConfirmed: false
    })
  },

  setPublishMessage(message) {
    set({ publishMessage: message })
  },

  setPublishConfirmed(confirmed) {
    set({ publishConfirmed: confirmed })
  },

  async runPublish() {
    const cms = window.cms
    const { publishMessage, publishFiles, publishConfirmed } = get()
    if (!cms) return
    set({ publishing: true, error: null })
    const res = await cms.publish.run({
      message: publishMessage,
      files: publishFiles,
      confirmed: publishConfirmed
    })
    if (!res.ok) {
      set({ publishing: false, error: errorText(res) })
      return
    }
    set({
      publishing: false,
      publishState: res.data,
      publishConfirmed: false,
      status:
        res.data.phase === 'pushed'
          ? `已推送 ${res.data.branch} @ ${res.data.commitSha?.slice(0, 8)}`
          : `已提交但推送失败：${res.data.error?.message ?? '未知错误'}`
    })
    await get().runPreflight()
    await get().loadPublishState()
  },

  async retryPublish() {
    const cms = window.cms
    if (!cms) return
    set({ publishing: true, error: null })
    const res = await cms.publish.retryPush()
    if (!res.ok) {
      set({ publishing: false, error: errorText(res) })
      return
    }
    set({
      publishing: false,
      publishState: res.data,
      status: res.data.pushed ? '重试推送成功' : `重试推送仍失败：${res.data.error?.message ?? ''}`
    })
    await get().runPreflight()
  },

  async gitPull() {
    const cms = window.cms
    if (!cms) return
    set({ publishing: true, error: null })
    const res = await cms.git.pull()
    if (!res.ok) {
      set({ publishing: false, error: errorText(res) })
      return
    }
    set({ publishing: false, gitStatus: res.data, status: `拉取完成：${res.data.summary}` })
    await get().runPreflight()
  },

  /** 一键回滚（P5 可选）：对上一次发布生成反向提交，绝不改写历史 */
  async rollbackPublish() {
    const cms = window.cms
    if (!cms) return
    const state = get().publishState
    const sha = state?.commitSha ?? ''
    if (!sha) {
      set({ status: '没有可回滚的发布记录' })
      return
    }
    const pushed = state?.phase === 'pushed'
    const confirmed = window.confirm(
      `将对提交 ${sha.slice(0, 10)} 生成一个反向提交（git revert，不改写历史）。\n` +
        (pushed ? '回滚提交也会推送到远端。\n' : '') +
        '继续？'
    )
    if (!confirmed) return

    set({ publishing: true, error: null })
    const res = await cms.publish.revert({ confirmed: true, push: pushed })
    if (!res.ok) {
      set({ publishing: false, error: errorText(res) })
      return
    }
    set({
      publishing: false,
      publishState: res.data,
      status: res.data.pushed
        ? `已回滚并推送：${res.data.commitSha?.slice(0, 8) ?? ''}`
        : `已生成反向提交但推送失败：${res.data.error?.message ?? '未知错误'}`
    })
    await get().runPreflight()
  },

  async resetPublish() {
    const cms = window.cms
    if (!cms) return
    const res = await cms.publish.clear()
    if (!res.ok) {
      set({ error: errorText(res) })
      return
    }
    set({ publishState: res.data, status: '已清除发布状态记录' })
  },

  setDeployProvider(provider) {
    set({ deployProvider: provider, deployStatus: null })
  },

  async runDeployStatus(wait = true) {
    const cms = window.cms
    if (!cms) return
    if (wait) set({ deploying: true, error: null })
    const res = await cms.deploy.status({
      provider: get().deployProvider,
      sha: get().publishState?.commitSha ?? undefined,
      wait
    })
    if (!res.ok) {
      set({ deploying: false, error: errorText(res) })
      return
    }
    set({
      deploying: false,
      deployStatus: res.data,
      status: `部署状态：${deployStateLabel(res.data.state)}${
        res.data.rawState !== 'unknown' ? `（${res.data.rawState}）` : ''
      }`
    })
  },

  clearDeployStatus() {
    set({ deployStatus: null, status: '已清除部署查询结果' })
  }
  }
})