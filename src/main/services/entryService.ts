import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CmsError } from '../errors'
import { resolveInsideRoot, assertSafeSlug } from '../security/pathGuard'
import {
  atomicWriteText,
  backupFile,
  readFingerprint,
  readText,
  type FileFingerprint
} from './atomicFile'
import { assertUnchanged } from './conflictService'
import { planPatch, type FrontmatterPatch, type PatchChange } from './contentPatchService'
import { diffLines, summarize, type DiffLine, type DiffSummary } from './diffService'
import { assembleDocument, parseDocument } from './frontmatterService'
import { CONTENT_SECTIONS, schemaOf, type ContentSection, type FieldSpec } from './schemaService'
import { assertDeletable, validateFrontmatter, validatePatch, type Issue } from './validateService'

/**
 * 条目编排层（P1）：读 / patch / 保存 / dry-run / 校验。
 * 不 import electron —— 工作区根与备份根由调用方（IPC 层）注入，便于用临时目录做单测。
 */

export interface ContentEntry {
  slug: string
  file: string
  title: string | null
  date: string | null
  draft: boolean
  size: number
  mtimeMs: number
  parseError: string | null
}

export interface SectionSummary {
  section: ContentSection
  dir: string
  count: number
  entries: ContentEntry[]
}

export interface EntryDocument {
  section: ContentSection
  slug: string
  file: string
  fingerprint: FileFingerprint
  /** YAML 原文（逐字节） */
  frontmatterRaw: string
  body: string
  data: Record<string, unknown>
  dataError: string | null
  text: string
}

export interface SaveParams {
  workspaceRoot: string
  backupRoot: string
  section: ContentSection
  slug: string
  /** 字段级 patch；省略表示不动 frontmatter */
  patch?: FrontmatterPatch
  /** 新正文；省略表示不动正文 */
  body?: string
  /** 读取时记录的指纹，用于乐观锁 */
  expected: FileFingerprint
  /** 用户在冲突裁决中确认「强制覆盖」时为 true */
  force?: boolean
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

export function entryFile(workspaceRoot: string, section: ContentSection, slug: string): string {
  return resolveInsideRoot(workspaceRoot, 'content', section, `${assertSafeSlug(slug)}.md`)
}

function toDateString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10)
  return null
}

/** 只读枚举某分区的 Markdown 清单（纯 fs，不依赖 electron） */
export function scanSection(workspaceRoot: string, section: ContentSection): SectionSummary {
  const dir = resolveInsideRoot(workspaceRoot, 'content', section)
  let entries: ContentEntry[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() && item.name.endsWith('.md') && !item.name.startsWith('.'))
      .map((item) => {
        const file = join(dir, item.name)
        const stat = statSync(file)
        const entry: ContentEntry = {
          slug: item.name.replace(/\.md$/, ''),
          file,
          title: null,
          date: null,
          draft: false,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          parseError: null
        }
        try {
          const doc = parseDocument(readText(file))
          entry.title = typeof doc.data.title === 'string' ? doc.data.title : null
          entry.date = toDateString(doc.data.date)
          entry.draft = doc.data.draft === true
          entry.parseError = doc.dataError
        } catch (err) {
          entry.parseError = err instanceof Error ? err.message : String(err)
        }
        return entry
      })
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.slug.localeCompare(b.slug))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new CmsError('FS_ERROR', `读取分区失败：${dir}`, err instanceof Error ? err.message : String(err))
    }
  }
  return { section, dir, count: entries.length, entries }
}

export function scanAll(workspaceRoot: string): SectionSummary[] {
  return CONTENT_SECTIONS.map((section) => scanSection(workspaceRoot, section))
}

export function readEntry(workspaceRoot: string, section: ContentSection, slug: string): EntryDocument {
  const file = entryFile(workspaceRoot, section, slug)
  const text = readText(file)
  const fingerprint = readFingerprint(file)
  const doc = parseDocument(text)
  return {
    section,
    slug,
    file,
    fingerprint,
    frontmatterRaw: doc.frontmatterRaw,
    body: doc.body,
    data: doc.data,
    dataError: doc.dataError,
    text
  }
}

/** 计算「应用 patch + 正文替换」后的目标文本，不落盘（dry-run 与保存共用） */
function planText(
  section: ContentSection,
  text: string,
  patch: FrontmatterPatch | undefined,
  body: string | undefined
): { text: string; changes: PatchChange[]; skipped: string[]; beforeRaw: string; afterRaw: string } {
  const doc = parseDocument(text)
  const outcome = patch ? planPatch(doc, patch) : {
    text,
    frontmatterRaw: doc.frontmatterRaw,
    changes: [] as PatchChange[],
    changed: false,
    skipped: [] as string[]
  }
  const next = assembleDocument(doc, outcome.frontmatterRaw, body)
  return {
    text: next,
    changes: outcome.changes,
    skipped: outcome.skipped,
    beforeRaw: doc.frontmatterRaw,
    afterRaw: outcome.frontmatterRaw
  }
}

function assertValid(section: ContentSection, text: string, patch: FrontmatterPatch | undefined): void {
  if (patch) {
    const patchResult = validatePatch(section, patch)
    if (!patchResult.ok) throwValidation(patchResult.blocking)
  }
  const nextData = parseDocument(text).data
  const result = validateFrontmatter(section, nextData)
  if (!result.ok) throwValidation(result.blocking)
}

function throwValidation(issues: Issue[]): never {
  const first = issues[0]
  throw new CmsError(
    'VALIDATION_FAILED',
    first ? first.message : '校验未通过',
    first?.hint,
    { issues }
  )
}

export function dirtyDiff(
  workspaceRoot: string,
  section: ContentSection,
  slug: string,
  patch?: FrontmatterPatch,
  body?: string
): { diff: DiffLine[]; summary: DiffSummary; changes: PatchChange[]; skipped: string[]; text: string } {
  const file = entryFile(workspaceRoot, section, slug)
  const current = readText(file)
  const planned = planText(section, current, patch, body)
  const beforeDoc = parseDocument(current)
  const afterDoc = parseDocument(planned.text)
  const diff = diffLines(current, planned.text)
  const summary = summarize(diff, {
    beforeData: beforeDoc.data,
    afterData: afterDoc.data,
    beforeRaw: planned.beforeRaw,
    afterRaw: planned.afterRaw
  })
  return { diff, summary, changes: planned.changes, skipped: planned.skipped, text: planned.text }
}

export function saveEntry(params: SaveParams): SaveResult {
  const { workspaceRoot, backupRoot, section, slug, patch, body, expected, force } = params
  const file = entryFile(workspaceRoot, section, slug)

  // 1) 乐观锁：外部改动则阻断（除非用户已确认强制覆盖）
  if (!force) assertUnchanged(file, expected)

  const current = readText(file)
  const planned = planText(section, current, patch, body)

  // 2) 校验：patch 字段 + 应用后的完整数据
  assertValid(section, planned.text, patch)

  const beforeDoc = parseDocument(current)
  const afterDoc = parseDocument(planned.text)
  const diff = diffLines(current, planned.text)
  const summary = summarize(diff, {
    beforeData: beforeDoc.data,
    afterData: afterDoc.data,
    beforeRaw: planned.beforeRaw,
    afterRaw: planned.afterRaw
  })

  if (planned.text === current) {
    return {
      file,
      fingerprint: readFingerprint(file),
      changes: [],
      skipped: planned.skipped,
      backupPath: null,
      diff,
      summary,
      changed: false
    }
  }

  // 3) 备份 → 4) 原子写
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupRoot, section, slug, `${stamp}.md`)
  backupFile(file, backupPath)
  atomicWriteText(file, planned.text)

  return {
    file,
    fingerprint: readFingerprint(file),
    changes: planned.changes,
    skipped: planned.skipped,
    backupPath,
    diff,
    summary,
    changed: true
  }
}

export interface FileValidation {
  section: ContentSection
  slug: string
  file: string
  blocking: Issue[]
  warnings: Issue[]
}

/** 全仓校验：契约 + 引用完整性（cover 存在性、projects.article 指向的 blog slug） */
export function validateWorkspace(workspaceRoot: string): {
  files: FileValidation[]
  blockingCount: number
  warningCount: number
} {
  const blogSlugs = scanSection(workspaceRoot, 'blog').entries.map((entry) => entry.slug)
  const files: FileValidation[] = []
  let blockingCount = 0
  let warningCount = 0

  for (const section of CONTENT_SECTIONS) {
    for (const entry of scanSection(workspaceRoot, section).entries) {
      const doc = parseDocument(readText(entry.file))
      const result = validateFrontmatter(section, doc.data, {
        knownBlogSlugs: section === 'projects' ? blogSlugs : undefined,
        publicDirExists: (relPath) => existsSync(join(workspaceRoot, 'public', relPath.replace(/^\//, '')))
      })
      if (doc.dataError) {
        result.blocking.push({
          level: 'block',
          message: `frontmatter 解析失败：${doc.dataError}`,
          hint: '无法读取字段，保存与发布会阻断'
        })
      }
      blockingCount += result.blocking.length
      warningCount += result.warnings.length
      files.push({
        section,
        slug: entry.slug,
        file: entry.file,
        blocking: result.blocking,
        warnings: result.warnings
      })
    }
  }
  return { files, blockingCount, warningCount }
}

/* ------------------------------------------------------------------ *
 * 内容管理闭环（P3）：新建 / 删除 / 重命名 / 封面枚举
 * 全部为纯 fs，不 import electron；空分区保护与引用级联提示在此收口。
 * ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 「新建」时的默认日期：取本地日历日，避免 toISOString 的 UTC 偏移导致差一天 */
function todayString(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 与现有内容书写风格一致：字符串一律双引号，日期裸写，数组内联 */
function yamlScalar(spec: FieldSpec | undefined, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map((item) => yamlScalar(undefined, String(item))).join(', ')}]`
  const text = String(value)
  if (spec?.kind === 'date' && DATE_RE.test(text)) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 按 schema.order 的书写顺序渲染 frontmatter（仅用于新建，不参与字段级 patch） */
function renderFrontmatter(section: ContentSection, data: Record<string, unknown>): string {
  const schema = schemaOf(section)
  const declared = schema.order.filter((key) => data[key] !== undefined)
  const extra = Object.keys(data).filter((key) => !schema.order.includes(key))
  const lines = [...declared, ...extra].map((key) => {
    const spec = schema.fields.find((field) => field.key === key)
    return `${key}: ${yamlScalar(spec, data[key])}`
  })
  return lines.join('\n') + '\n'
}

/** 生成一份「自洽合法」的初始 frontmatter：必填字段给合理默认值，用户再改 */
function defaultFrontmatter(
  section: ContentSection,
  opts: { slug: string; title?: string; date?: string }
): Record<string, unknown> {
  const schema = schemaOf(section)
  const data: Record<string, unknown> = {}
  for (const spec of schema.fields) {
    if (!spec.required) continue
    switch (spec.kind) {
      case 'date':
        data[spec.key] = opts.date ?? todayString()
        break
      case 'enum':
        data[spec.key] = spec.options?.[0] ?? ''
        break
      default:
        data[spec.key] = opts.title ?? opts.slug
    }
  }
  // projects / goals 的排序字段有站点默认语义，显式写出避免缺省
  if (section === 'projects' || section === 'goals') data.order = 999
  return data
}

export interface CreateEntryParams {
  workspaceRoot: string
  section: ContentSection
  slug: string
  /** 标题（可选；缺省用 slug 顶替必填的 title） */
  title?: string
  /** 日期（可选；缺省用本地今天） */
  date?: string
}

export interface CreateEntryResult {
  section: ContentSection
  slug: string
  file: string
  fingerprint: FileFingerprint
}

export function createEntry(params: CreateEntryParams): CreateEntryResult {
  const { workspaceRoot, section } = params
  const slug = assertSafeSlug(params.slug)
  const file = entryFile(workspaceRoot, section, slug)
  if (existsSync(file)) {
    throw new CmsError(
      'ENTRY_EXISTS',
      `条目已存在：content/${section}/${slug}.md`,
      '换一个文件名，或直接打开现有条目'
    )
  }

  const data = defaultFrontmatter(section, { slug, title: params.title, date: params.date })
  const validation = validateFrontmatter(section, data)
  if (!validation.ok) throwValidation(validation.blocking)

  const text = `---\n${renderFrontmatter(section, data)}---\n\n`
  mkdirSync(dirname(file), { recursive: true })
  atomicWriteText(file, text)
  return { section, slug, file, fingerprint: readFingerprint(file) }
}

export interface DeleteEntryResult {
  section: ContentSection
  slug: string
  file: string
  backupPath: string
  /** 删除后该分区的剩余篇数 */
  remaining: number
}

export function deleteEntry(
  workspaceRoot: string,
  backupRoot: string,
  section: ContentSection,
  slug: string
): DeleteEntryResult {
  const safeSlug = assertSafeSlug(slug)
  const file = entryFile(workspaceRoot, section, safeSlug)
  if (!existsSync(file)) {
    throw new CmsError('ENTRY_NOT_FOUND', `条目不存在：content/${section}/${safeSlug}.md`)
  }
  const summary = scanSection(workspaceRoot, section)
  // 删除保护：blog/diary/projects 不允许删空（Next 16 generateStaticParams 不接受空数组）
  assertDeletable(section, summary.count - 1)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupRoot, section, safeSlug, `${stamp}.md`)
  backupFile(file, backupPath)
  unlinkSync(file)
  return { section, slug: safeSlug, file, backupPath, remaining: summary.count - 1 }
}

export interface RenameReference {
  section: ContentSection
  slug: string
  file: string
  field: string
  value: string
}

export interface RenameEntryResult {
  section: ContentSection
  from: string
  to: string
  file: string
  previousFile: string
  /** 指向旧 slug 的引用（如 projects.article）——只提示，不自动改写 */
  references: RenameReference[]
  /** blog 重命名后旧地址会 404（站点无重定向机制） */
  staleUrl: string | null
}

/** 扫描所有 projects 条目里 `article === blogSlug` 的引用，供重命名时提示级联 */
function scanArticleReferences(workspaceRoot: string, blogSlug: string): RenameReference[] {
  const refs: RenameReference[] = []
  for (const entry of scanSection(workspaceRoot, 'projects').entries) {
    const doc = parseDocument(readText(entry.file))
    if (doc.data.article === blogSlug) {
      refs.push({ section: 'projects', slug: entry.slug, file: entry.file, field: 'article', value: blogSlug })
    }
  }
  return refs
}

export function renameEntry(
  workspaceRoot: string,
  section: ContentSection,
  slug: string,
  nextSlug: string
): RenameEntryResult {
  const fromSlug = assertSafeSlug(slug)
  const toSlug = assertSafeSlug(nextSlug)
  if (fromSlug === toSlug) {
    throw new CmsError('INVALID_SLUG', '新旧文件名相同', '请输入不同的文件名')
  }
  const file = entryFile(workspaceRoot, section, fromSlug)
  const nextFile = entryFile(workspaceRoot, section, toSlug)
  if (!existsSync(file)) {
    throw new CmsError('ENTRY_NOT_FOUND', `条目不存在：content/${section}/${fromSlug}.md`)
  }
  if (existsSync(nextFile)) {
    throw new CmsError('ENTRY_EXISTS', `目标文件名已存在：content/${section}/${toSlug}.md`)
  }

  // 同分区内同目录改名：renameSync 保留逐字节内容（不重排 frontmatter）
  renameSync(file, nextFile)

  return {
    section,
    from: fromSlug,
    to: toSlug,
    file: nextFile,
    previousFile: file,
    references: section === 'blog' ? scanArticleReferences(workspaceRoot, fromSlug) : [],
    staleUrl: section === 'blog' ? `/blog/${fromSlug}` : null
  }
}

export interface CoverOption {
  /** public/ 下的站点绝对路径（以 / 开头），直接写入 frontmatter.cover */
  path: string
  file: string
}

/** 枚举 public/ 下所有 .svg 作为封面候选（用于表单下拉，校验仍是 warn 级） */
export function listCovers(workspaceRoot: string): CoverOption[] {
  const out: CoverOption[] = []
  const walk = (dir: string, rel: string): void => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const nextRel = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) walk(join(dir, item.name), nextRel)
      else if (item.name.toLowerCase().endsWith('.svg')) out.push({ path: `/${nextRel}`, file: join(dir, item.name) })
    }
  }
  walk(join(workspaceRoot, 'public'), '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}