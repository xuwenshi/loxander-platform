import { create } from 'zustand'
import type {
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

export const useCms = create<CmsState>((set, get) => ({
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
      busy: false,
      status: `已加载 ${sections.reduce((sum, item) => sum + item.count, 0)} 篇内容`
    })

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

    const { activeSection, activeSlug, doc } = get()
    if (!doc || !activeSlug) return
    if (!event.paths.includes(currentEntryPath(activeSection, activeSlug))) return

    if (get().isDirty()) {
      set({
        externalChange: { paths: event.paths, at: event.at },
        status: '检测到外部改动：当前文件已被其他程序修改'
      })
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
      return
    }
    // 磁盘内容与本机基线一致（例如刚由本 CMS 保存触发的事件）：无需跟随，也不打扰状态栏
    if (res.data.fingerprint.sha256 === doc.fingerprint.sha256) {
      set({ externalChange: null })
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

  selectSection(section) {
    if (get().isDirty()) {
      const ok = window.confirm('当前条目有未保存改动，切换分区将丢弃这些改动。继续？')
      if (!ok) return
    }
    set({ activeSection: section, activeSlug: null, ...emptyState() })
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
  },

  closeEntry() {
    if (get().isDirty()) {
      const ok = window.confirm('当前条目有未保存改动，关闭将丢弃这些改动。继续？')
      if (!ok) return
    }
    set({ activeSlug: null, ...emptyState() })
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
  },

  discard() {
    const { baseline, baselineBody } = get()
    set({ fields: { ...baseline }, body: baselineBody, preview: null, conflict: null, error: null, status: '已放弃改动' })
  },

  async reloadFromDisk() {
    const { activeSection, activeSlug } = get()
    if (!activeSlug) return
    set({ conflict: null, externalChange: null })
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
}))