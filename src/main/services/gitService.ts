import { isAbsolute, relative, resolve, sep } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { CmsError } from '../errors'

/**
 * Git 服务（P2）：simple-git 封装，作为「人工确认后发布」闸门的下半段。
 *
 * 安全约定（关键）：
 * - **只接受显式文件清单**：`add` / `commit` 一律走 `-- <paths>`，禁止 `-A` / `.` / 通配，
 *   避免把用户未确认的改动（尤其非内容改动）一并提交。
 * - `commit` 用 pathspec 做**部分提交**，并回读 `show --name-only` 复核，实际提交集合必须 ⊆ 清单。
 * - push / pull 注入 socks5 代理（本机直连 GitHub 不通，ADR-7），并禁用交互式凭据提示以免挂死。
 */

export interface GitFileStatus {
  path: string
  index: string
  workingDir: string
  /** 已进入暂存区（index 列非空白且非未跟踪） */
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

export interface GitCommitResult {
  sha: string
  branch: string
  files: string[]
}

export interface GitPushResult {
  pushed: boolean
  remote: string
  branch: string
}

export interface GitPullResult {
  updated: boolean
  summary: string
}

/** 单次 diff 文本的 IPC 传输上限，超出则截断（stat 仍完整） */
const MAX_DIFF_BYTES = 400_000

/** 明确禁止的文件参数：全量 add 语义 / 通配 / 选项注入 */
const FORBIDDEN_ARGS = new Set(['.', '-A', '--all', '-a', '-u', '--update', '*', ':/', '--', ''])
const GLOB_CHARS = /[*?[\]{}]/

/** 把被提交/暂存的文件清单归一为 root 下的相对 posix 路径，不安全直接拒绝 */
export function assertSafeFileList(root: string, files: unknown): string[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new CmsError(
      'GIT_UNSAFE_PATH',
      '未指定要提交的文件清单',
      '发布必须显式列出文件，禁止全量提交（git add -A / .）'
    )
  }

  const base = resolve(root)
  const out: string[] = []

  for (const raw of files) {
    const value = String(raw ?? '').trim()
    if (!value) continue
    if (FORBIDDEN_ARGS.has(value) || value.startsWith('-')) {
      throw new CmsError('GIT_UNSAFE_PATH', `不安全的文件参数：${value}`, '只允许 content/ 下的相对文件路径')
    }
    if (GLOB_CHARS.test(value)) {
      throw new CmsError('GIT_UNSAFE_PATH', `文件清单不允许通配：${value}`, '请逐个列出具体文件')
    }
    if (isAbsolute(value)) {
      throw new CmsError('GIT_UNSAFE_PATH', `文件清单不允许绝对路径：${value}`, '请使用相对于仓库根的路径')
    }
    const abs = resolve(base, value)
    if (abs !== base && !abs.startsWith(base + sep)) {
      throw new CmsError('PATH_ESCAPE', '提交路径越出仓库根目录，已拒绝', `根目录：${base}`)
    }
    out.push(relative(base, abs).split(sep).join('/'))
  }

  if (out.length === 0) {
    throw new CmsError('GIT_UNSAFE_PATH', '文件清单为空', '请勾选至少一个文件')
  }
  return [...new Set(out)]
}

/**
 * 允许注入子进程的环境变量白名单。
 * simple-git v4 会校验 `.env()` 的键：像 GIT_ASKPASS / EDITOR 这类键默认被判定为「不安全」而拒用，
 * 因此这里只注入代理与「禁用交互式凭据提示」（后者足以避免 push/pull 因缺凭据而挂死）。
 */
const ALLOWED_ENV = ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'GIT_TERMINAL_PROMPT'] as const

function proxyEnv(proxy: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  const value = (proxy ?? '').trim()
  if (value) {
    env.ALL_PROXY = value
    env.HTTPS_PROXY = value
    env.HTTP_PROXY = value
  }
  return env
}

export function gitFor(root: string, proxy = ''): SimpleGit {
  const env = proxyEnv(proxy)
  return simpleGit({
    baseDir: resolve(root),
    maxConcurrentProcesses: 1,
    allowEnvironment: [...ALLOWED_ENV]
  }).env(env)
}

function rawText(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  const extra = (err as { stderr?: string; stdout?: string } | null) ?? {}
  return [base, extra.stderr ?? '', extra.stdout ?? ''].join('\n')
}

/** 把 git 的原始报错归类成可供 UI 映射的稳定错误码 */
export function classifyGitError(err: unknown, action: string): CmsError {
  if (err instanceof CmsError) return err
  const text = rawText(err)
  const lower = text.toLowerCase()

  if (/authentication failed|could not read username|permission denied|invalid username or password|terminal prompts disabled|support for password authentication|\b403\b|\b401\b/.test(lower)) {
    return new CmsError(
      'GIT_AUTH',
      `git ${action} 认证失败`,
      '请检查远端凭据（HTTPS token / SSH key）与该仓库的推送权限',
      text
    )
  }
  if (/non-fast-forward|\(rejected\)|fetch first|failed to push some refs|would be overwritten|diverged/.test(lower)) {
    return new CmsError(
      'GIT_REJECTED',
      `git ${action} 被拒绝：远端有本地没有的提交`,
      '执行「拉取（--ff-only）」同步远端后，再重新推送',
      text
    )
  }
  if (/could not resolve host|connection reset|failed to connect|proxy|timed out|network is unreachable|ssl|unable to access|couldn't connect/.test(lower)) {
    return new CmsError(
      'GIT_NETWORK',
      `git ${action} 网络失败`,
      '本机需经 socks5 代理访问 GitHub，请在设置中确认代理地址与端口',
      text
    )
  }
  return new CmsError('GIT_FAILED', `git ${action} 失败`, undefined, text)
}

async function run<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw classifyGitError(err, action)
  }
}

/** 读取远端 URL（origin 等），供部署回读推导 owner/repo；远端不存在时返回空串 */
export async function getRemoteUrl(root: string, proxy: string, remote: string): Promise<string> {
  const name = String(remote ?? '').trim() || 'origin'
  try {
    const git = gitFor(root, proxy)
    const out = await git.raw(['remote', 'get-url', name])
    return out.trim()
  } catch {
    return ''
  }
}

export async function getStatus(root: string, proxy = ''): Promise<GitStatus> {
  const git = gitFor(root, proxy)
  const isRepo = await probe(() => git.checkIsRepo(), false)
  if (!isRepo) {
    return { isRepo: false, branch: '', tracking: null, ahead: 0, behind: 0, clean: true, files: [] }
  }

  const status = await run('status', () => git.status())
  return {
    isRepo: true,
    branch: status.current ?? '',
    tracking: status.tracking ?? null,
    ahead: status.ahead,
    behind: status.behind,
    clean: status.isClean(),
    files: status.files.map((file) => ({
      path: toPosix(file.path),
      index: file.index,
      workingDir: file.working_dir,
      staged: file.index.trim() !== '' && file.index !== '?',
      untracked: file.index === '?'
    }))
  }
}

function toPosix(value: string): string {
  return value.split(sep).join('/').replace(/\\/g, '/')
}

/** checkIsRepo 等「探测型」调用失败不应冒泡为错误，而是返回兜底值 */
async function probe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export async function getDiff(
  root: string,
  proxy = '',
  options: { staged?: boolean; files?: string[] } = {}
): Promise<GitDiff> {
  const git = gitFor(root, proxy)
  const scope = options.staged ? ['--cached'] : []
  const files = options.files && options.files.length > 0 ? assertSafeFileList(root, options.files) : []
  const pathspec = files.length > 0 ? ['--', ...files] : []
  const args = [...scope, ...pathspec]

  const stat = await run('diff', () => git.diff([...args, '--stat']))
  const text = await run('diff', () => git.diff(args))
  const summary = await run('diff', () => git.diffSummary(scope.length ? ['--cached'] : []))

  const filesStat: GitDiffFile[] = summary.files.map((item) => ({
    path: item.file,
    insertions: 'insertions' in item ? item.insertions : 0,
    deletions: 'deletions' in item ? item.deletions : 0,
    binary: 'binary' in item ? Boolean(item.binary) : false
  }))

  const truncated = text.length > MAX_DIFF_BYTES
  return {
    stat: stat.trim(),
    text: truncated ? text.slice(0, MAX_DIFF_BYTES) : text,
    files: filesStat,
    truncated
  }
}

/** 只暂存显式清单（git add -- <paths>），不做任何全量操作 */
export async function stageFiles(root: string, proxy: string, files: unknown): Promise<string[]> {
  const safe = assertSafeFileList(root, files)
  const git = gitFor(root, proxy)
  await run('add', () => git.raw(['add', '--', ...safe]))
  return safe
}

export async function unstageFiles(root: string, proxy: string, files: unknown): Promise<string[]> {
  const safe = assertSafeFileList(root, files)
  const git = gitFor(root, proxy)
  await run('reset', () => git.raw(['reset', '--', ...safe]))
  return safe
}

/**
 * 部分提交：先 add 显式清单，再 `commit -- <paths>`（其余已暂存内容不会被带上）。
 * 提交后回读 `show --name-only` 复核，实际提交集合必须 ⊆ 清单，否则视为失败。
 */
export async function commitFiles(
  root: string,
  proxy: string,
  params: { message: string; files: unknown }
): Promise<GitCommitResult> {
  const message = String(params.message ?? '').trim()
  if (!message) {
    throw new CmsError('CONFIRM_REQUIRED', 'commit message 不能为空', '请填写本次发布说明后再提交')
  }
  const safe = assertSafeFileList(root, params.files)
  const git = gitFor(root, proxy)

  await run('add', () => git.raw(['add', '--', ...safe]))
  await run('commit', () => git.raw(['commit', '-m', message, '--', ...safe]))

  const sha = (await run('rev-parse', () => git.revparse(['HEAD']))).trim()
  const committedRaw = await run('show', () =>
    git.raw(['show', '--name-only', '--pretty=format:', 'HEAD'])
  )
  const committed = committedRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => toPosix(line))

  const unexpected = committed.filter((path) => !safe.includes(path))
  if (unexpected.length > 0) {
    throw new CmsError(
      'GIT_FAILED',
      `提交包含未确认的文件：${unexpected.join(', ')}`,
      '已阻止本次发布；请检查暂存区后重试',
      { committed, expected: safe }
    )
  }

  const branch = (await run('branch', () => git.revparse(['--abbrev-ref', 'HEAD']))).trim()
  return { sha, branch, files: committed }
}

export async function pushBranch(
  root: string,
  proxy: string,
  params: { remote: string; branch: string }
): Promise<GitPushResult> {
  const remote = String(params.remote ?? '').trim() || 'origin'
  const branch = String(params.branch ?? '').trim()
  if (!branch) throw new CmsError('GIT_FAILED', '未指定推送分支')
  const git = gitFor(root, proxy)
  await run('push', () => git.raw(['push', remote, branch]))
  return { pushed: true, remote, branch }
}

/** 单向快进拉取：绝不自动合并/变基（ADR-5），只在能 fast-forward 时前进 */
export async function pullFastForward(
  root: string,
  proxy: string,
  params: { remote: string; branch: string }
): Promise<GitPullResult> {
  const remote = String(params.remote ?? '').trim() || 'origin'
  const branch = String(params.branch ?? '').trim()
  if (!branch) throw new CmsError('GIT_FAILED', '未指定拉取分支')
  const git = gitFor(root, proxy)
  const out = await run('pull', () => git.raw(['pull', '--ff-only', remote, branch]))
  const summary = out.trim()
  return { updated: !/already up to date/i.test(summary), summary }
}

export interface GitRevertResult {
  /** 被回滚的原始提交 */
  sha: string
  /** 新生成的反向提交（HEAD） */
  revertedSha: string
  branch: string
}

/** SHA 白名单：只允许 7-40 位十六进制，杜绝把任意字符串塞进 git 参数（选项注入） */
const SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/

/**
 * 一键回滚（P5 可选）：对指定提交生成**反向提交**（`git revert --no-edit <sha>`）。
 * 绝不改写历史：不使用 `reset` / `--force`，因此远端无需强推，回滚之后仍可再次 revert 回来。
 * revert 冲突时 git 会留下半成品状态，这里立即 `--abort` 复原，避免污染用户工作区。
 */
export async function revertCommit(
  root: string,
  proxy: string,
  params: { sha: string }
): Promise<GitRevertResult> {
  const sha = String(params.sha ?? '').trim()
  if (!SHA_PATTERN.test(sha)) {
    throw new CmsError('GIT_FAILED', `非法的提交 SHA：${sha || '(空)'}`, '只允许 7-40 位十六进制提交号')
  }
  const git = gitFor(root, proxy)

  await run('revert', async () => {
    try {
      await git.raw(['revert', '--no-edit', sha])
    } catch (err) {
      try {
        await git.raw(['revert', '--abort'])
      } catch {
        /* 没有进行中的 revert 时 --abort 会报错，忽略即可 */
      }
      if (/conflict|unmerged|would be overwritten/i.test(rawText(err))) {
        throw new CmsError(
          'GIT_FAILED',
          '回滚遇到冲突，已中止并恢复原状',
          '被回滚的文件在发布后被再次修改，请先手动处理该文件后再回滚',
          rawText(err)
        )
      }
      throw err
    }
  })

  const revertedSha = (await run('rev-parse', () => git.revparse(['HEAD']))).trim()
  const branch = (await run('branch', () => git.revparse(['--abbrev-ref', 'HEAD']))).trim()
  return { sha, revertedSha, branch }
}