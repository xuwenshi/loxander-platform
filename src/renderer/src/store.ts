import { create } from 'zustand'
import type {
  CoverOption,
  DeployProvider,
  DeployState,
  DeployStatus,
  DirtyDiffResult,
  EntryDocument,
  GitStatus,
  Issue,
  PreflightReport,
  PublishState,
  SectionSchema,
  SectionSummary
} from '../../preload/api'
import { buildBaseline, buildPatch } from './formValue'

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
  workspaceIssues: { blocking: Issue[]; warnings: Issue[] }
  status: string
  error: string | null
  busy: boolean
  /** public/ 下的 .svg 候选（封面下拉） */
  covers: CoverOption[]

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
  pickWorkspace: () => Promise<void>
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

function emptyState() {
  return {
    doc: null,
    fields: {} as Record<string, unknown>,
    baseline: {} as Record<string, unknown>,
    body: '',
    baselineBody: '',
    preview: null,
    conflict: null,
    error: null
  }
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
    set({
      sections,
      schemas: schemaRes.data,
      workspaceRoot: listRes.data.workspaceRoot,
      activeSection: get().activeSection || sections[0]?.section || '',
      covers: coverRes.ok ? coverRes.data : [],
      deployProvider: settingsRes.ok ? settingsRes.data.deployProvider : 'github',
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
    set({
      activeSlug: slug,
      doc: res.data,
      baseline,
      fields: { ...baseline },
      body: res.data.body,
      baselineBody: res.data.body,
      preview: null,
      conflict: null,
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
    set({
      busy: false,
      doc: reloaded.data,
      baseline,
      fields: { ...baseline },
      body: reloaded.data.body,
      baselineBody: reloaded.data.body,
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
    set({ conflict: null })
    await get().openEntry(activeSlug)
    set({ status: `已重新加载磁盘版本（${activeSection}/${activeSlug}）` })
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