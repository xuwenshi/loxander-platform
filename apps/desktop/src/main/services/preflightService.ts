import { CONTENT_SECTIONS, schemaOf, type ContentSection } from './schemaService'
import { scanSection, validateWorkspace, type FileValidation } from './entryService'
import { getStatus, type GitFileStatus, type GitStatus } from './gitService'

/**
 * 发布预检（P2）：对齐基线 §4 的 PreflightReport。
 * 全绿（blocking === 0）才允许进入人工确认卡；取消或阻断路径**零副作用**（不写盘、不 commit）。
 *
 * 检查项：
 * 1. 内容契约 + 引用完整性（cover 存在性、projects.article 指向的 blog slug）—— 复用 validateWorkspace
 * 2. 分区非空保护（blog/diary/projects ≥ 1；Next 16 generateStaticParams 不接受空数组）
 * 3. Git：仓库有效、分支 == 目标分支、behind > 0 阻断
 * 4. 变更文件清单，并把「内容改动」与「非内容改动」分离，供确认卡逐项勾选
 */

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
  /** 是否属于 content/ 下的内容改动 */
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
  /** content/** 变更（默认勾选） */
  contentFiles: string[]
  /** 非内容变更（默认不勾选，需人工确认） */
  otherFiles: string[]
  suggestedMessage: string
  issues: PreflightIssue[]
  blocking: PreflightIssue[]
  warnings: PreflightIssue[]
  infos: PreflightIssue[]
  validation: { blockingCount: number; warningCount: number; files: FileValidation[] }
  sectionCounts: Record<string, number>
}

export interface PreflightOptions {
  workspaceRoot: string
  proxy: string
  remote: string
  branch: string
}

function isContentPath(path: string): boolean {
  return path === 'content' || path.startsWith('content/')
}

function suggestMessage(contentFiles: string[]): string {
  if (contentFiles.length === 0) return 'content: 内容更新'
  const names = contentFiles
    .slice(0, 6)
    .map((path) => path.replace(/^content\//, '').replace(/\.md$/, ''))
  const more = contentFiles.length > names.length ? ` 等 ${contentFiles.length} 篇` : ''
  return `content: 更新 ${names.join('、')}${more}`
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const { workspaceRoot: root, proxy, remote, branch } = options
  const issues: PreflightIssue[] = []

  const git = await getStatus(root, proxy)

  if (!git.isRepo) {
    issues.push({
      level: 'block',
      code: 'GIT_NOT_REPO',
      message: '工作区不是 Git 仓库，无法发布',
      hint: root
    })
  } else {
    if (git.branch !== branch) {
      issues.push({
        level: 'block',
        code: 'GIT_BRANCH',
        message: `当前分支为 ${git.branch || '(detached)'}，预期 ${branch}`,
        hint: '发布只允许在目标分支上进行；请先切换到正确分支'
      })
    }
    if (git.behind > 0) {
      issues.push({
        level: 'block',
        code: 'GIT_BEHIND',
        message: `本地落后远端 ${git.behind} 个提交，push 会被拒绝`,
        hint: '先执行「拉取（--ff-only）」同步远端，再运行预检'
      })
    }
    if (git.ahead > 0) {
      issues.push({
        level: 'info',
        code: 'GIT_AHEAD',
        message: `本地领先远端 ${git.ahead} 个提交`
      })
    }
  }

  // 1) 内容契约 + 引用完整性（整仓逐篇）
  const validation = validateWorkspace(root)
  if (validation.blockingCount > 0) {
    issues.push({
      level: 'block',
      code: 'CONTENT_BLOCKING',
      message: `内容校验存在 ${validation.blockingCount} 项阻断`,
      hint: '修复下方列出的文件/字段后再发布'
    })
  }
  if (validation.warningCount > 0) {
    issues.push({
      level: 'warn',
      code: 'CONTENT_WARNING',
      message: `内容校验存在 ${validation.warningCount} 项告警（不阻断发布）`
    })
  }

  // 2) 分区非空保护
  const sectionCounts: Record<string, number> = {}
  for (const section of CONTENT_SECTIONS as readonly ContentSection[]) {
    const count = scanSection(root, section).count
    sectionCounts[section] = count
    const minCount = schemaOf(section).minCount
    if (count < minCount) {
      issues.push({
        level: 'block',
        code: 'SECTION_EMPTY',
        message: `content/${section}/ 至少需要 ${minCount} 篇（当前 ${count}）`,
        hint: minCount > 0 ? 'Next 16 的 generateStaticParams 不接受空数组，删空会导致生产构建失败' : undefined
      })
    }
  }

  // 3) 变更文件清单（内容 / 非内容分离）
  const changedFiles: ChangedFile[] = git.files.map((file) => ({
    ...file,
    isContent: isContentPath(file.path)
  }))
  const contentFiles = changedFiles.filter((file) => file.isContent).map((file) => file.path)
  const otherFiles = changedFiles.filter((file) => !file.isContent).map((file) => file.path)

  if (otherFiles.length > 0) {
    issues.push({
      level: 'warn',
      code: 'NON_CONTENT_CHANGES',
      message: `工作区存在 ${otherFiles.length} 个非内容改动`,
      hint: '这些不是 CMS 产生的内容改动，默认不会提交；如需一并发布请在确认卡中手动勾选'
    })
  }
  if (changedFiles.length === 0) {
    issues.push({ level: 'info', code: 'CLEAN_TREE', message: '工作区干净，没有可发布的改动' })
  } else if (contentFiles.length === 0) {
    issues.push({ level: 'info', code: 'NO_CONTENT_CHANGES', message: 'content/ 下没有待发布的改动' })
  }

  const blocking = issues.filter((issue) => issue.level === 'block')
  const warnings = issues.filter((issue) => issue.level === 'warn')
  const infos = issues.filter((issue) => issue.level === 'info')

  return {
    ok: blocking.length === 0,
    generatedAt: new Date().toISOString(),
    workspaceRoot: root,
    remote,
    expectedBranch: branch,
    git,
    changedFiles,
    contentFiles,
    otherFiles,
    suggestedMessage: suggestMessage(contentFiles),
    issues,
    blocking,
    warnings,
    infos,
    validation,
    sectionCounts
  }
}