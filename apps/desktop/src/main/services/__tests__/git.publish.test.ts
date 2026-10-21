import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSafeFileList, getStatus, commitFiles, revertCommit } from '../gitService'
import { runPreflight } from '../preflightService'
import { publish, pullRecover, readPublishState, retryPush, rollbackLast } from '../publishService'

/**
 * P2 门禁测试：全部在**临时仓库**上运行，绝不触碰 my-blog。
 * 远端用本地 bare 仓库（file 传输，无需网络/代理），因此 push / pull 链路可离线验证。
 */

const VALID_FILES: Record<string, string> = {
  'content/blog/post-one.md': '---\ntitle: "第一篇"\ndescription: "摘要"\ndate: 2026-01-01\n---\n\n正文一\n',
  'content/diary/diary-one.md': '---\ntitle: "日记一则"\nsummary: "摘要"\ndate: 2026-01-02\n---\n\n正文二\n',
  'content/projects/proj-one.md': '---\nname: "项目一"\ndescription: "描述"\nstatus: active\n---\n\n正文三\n',
  'content/goals/goal-one.md': '---\ntitle: "目标一"\nhorizon: short\nstatus: planned\n---\n\n正文四\n'
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function writeRepoFile(root: string, relative: string, content: string): void {
  const file = join(root, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function seedRepo(root: string): void {
  for (const [relative, content] of Object.entries(VALID_FILES)) writeRepoFile(root, relative, content)
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'chore: 初始内容'])
}

let root = ''
let stateRoot = ''
let remotes: string[] = []

function makeRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cms-remote-'))
  execFileSync('git', ['init', '--bare', '-b', 'main', dir], { encoding: 'utf8' })
  remotes.push(dir)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cms-repo-'))
  stateRoot = mkdtempSync(join(tmpdir(), 'cms-state-'))
  remotes = []
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.email', 'cms@test.local'])
  git(root, ['config', 'user.name', 'CMS Test'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['config', 'core.autocrlf', 'false'])
  seedRepo(root)
})

afterEach(() => {
  for (const dir of [root, stateRoot, ...remotes]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发文件锁，忽略 */
    }
  }
})

describe('文件清单安全（禁止全量 add）', () => {
  it('拒绝 . / -A / 通配 / 空清单 / 越界路径', () => {
    for (const bad of [['.'], ['-A'], ['--all'], ['content/**/*.md'], [], ['../outside.md'], ['E:/abs.md']]) {
      expect(() => assertSafeFileList(root, bad)).toThrowError()
    }
  })

  it('归一相对路径并去重', () => {
    const safe = assertSafeFileList(root, ['./content/blog/post-one.md', 'content/blog/post-one.md'])
    expect(safe).toEqual(['content/blog/post-one.md'])
  })
})

describe('部分提交（只提交显式清单）', () => {
  it('改两个文件只提交一个，另一个保持未提交', async () => {
    writeRepoFile(root, 'content/blog/post-one.md', '---\ntitle: "改过的标题"\ndescription: "摘要"\ndate: 2026-01-01\n---\n\n正文一\n')
    writeRepoFile(root, 'content/diary/diary-one.md', '---\ntitle: "改过的日记"\nsummary: "摘要"\ndate: 2026-01-02\n---\n\n正文二\n')

    const result = await commitFiles(root, '', {
      message: 'content: 只改 blog',
      files: ['content/blog/post-one.md']
    })

    expect(result.files).toEqual(['content/blog/post-one.md'])
    const committed = git(root, ['show', '--name-only', '--pretty=format:', 'HEAD']).trim()
    expect(committed).toBe('content/blog/post-one.md')

    const status = await getStatus(root, '')
    expect(status.files.map((file) => file.path)).toEqual(['content/diary/diary-one.md'])
  })

  it('空 commit message 被拒绝', async () => {
    writeRepoFile(root, 'content/blog/post-one.md', '---\ntitle: "x"\ndescription: "y"\ndate: 2026-01-01\n---\n\nz\n')
    await expect(
      commitFiles(root, '', { message: '   ', files: ['content/blog/post-one.md'] })
    ).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
  })
})

describe('预检报告', () => {
  it('干净仓库：ok 且提示无可发布改动', async () => {
    const report = await runPreflight({ workspaceRoot: root, proxy: '', remote: 'origin', branch: 'main' })
    expect(report.ok).toBe(true)
    expect(report.infos.some((issue) => issue.code === 'CLEAN_TREE')).toBe(true)
    expect(report.sectionCounts).toMatchObject({ blog: 1, diary: 1, projects: 1, goals: 1 })
  })

  it('内容改动归入 contentFiles；非内容改动只告警且默认不提交', async () => {
    writeRepoFile(root, 'content/blog/post-one.md', '---\ntitle: "新标题"\ndescription: "摘要"\ndate: 2026-01-01\n---\n\n正文一\n')
    writeRepoFile(root, 'src/note.txt', 'not content\n')

    const report = await runPreflight({ workspaceRoot: root, proxy: '', remote: 'origin', branch: 'main' })
    expect(report.ok).toBe(true)
    expect(report.contentFiles).toEqual(['content/blog/post-one.md'])
    expect(report.otherFiles).toEqual(['src/note.txt'])
    expect(report.warnings.some((issue) => issue.code === 'NON_CONTENT_CHANGES')).toBe(true)
  })

  it('分区删空被阻断', async () => {
    rmSync(join(root, 'content/blog/post-one.md'))
    const report = await runPreflight({ workspaceRoot: root, proxy: '', remote: 'origin', branch: 'main' })
    expect(report.ok).toBe(false)
    expect(report.blocking.some((issue) => issue.code === 'SECTION_EMPTY')).toBe(true)
  })
})

describe('发布状态机与闸门', () => {
  it('未确认 => CONFIRM_REQUIRED，零副作用', async () => {
    writeRepoFile(root, 'content/blog/post-one.md', '---\ntitle: "A"\ndescription: "摘要"\ndate: 2026-01-01\n---\n\n正文一\n')
    const head = git(root, ['rev-parse', 'HEAD']).trim()

    await expect(
      publish({
        workspaceRoot: root,
        stateRoot,
        proxy: '',
        remote: 'origin',
        branch: 'main',
        message: 'content: A',
        files: ['content/blog/post-one.md'],
        confirmed: false
      })
    ).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })

    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(head)
    expect(readPublishState(stateRoot).phase).toBe('idle')
  })

  it('预检未过（behind > 0）=> PREFLIGHT_FAILED，零副作用', async () => {
    const remote = makeRemote()
    git(root, ['remote', 'add', 'origin', remote])
    git(root, ['push', '-u', 'origin', 'main'])

    // 远端再多一个提交，本地回退到上一个 => behind = 1
    writeRepoFile(root, 'content/blog/post-two.md', '---\ntitle: "第二篇"\ndescription: "摘要"\ndate: 2026-01-03\n---\n\n正文五\n')
    git(root, ['add', '--', 'content/blog/post-two.md'])
    git(root, ['commit', '-m', 'content: 第二篇'])
    git(root, ['push', 'origin', 'main'])
    git(root, ['reset', '--hard', 'HEAD~1'])
    git(root, ['fetch', 'origin'])

    const before = await getStatus(root, '')
    expect(before.behind).toBe(1)

    writeRepoFile(root, 'content/diary/diary-one.md', '---\ntitle: "待发布"\nsummary: "摘要"\ndate: 2026-01-02\n---\n\n正文二\n')
    const head = git(root, ['rev-parse', 'HEAD']).trim()

    await expect(
      publish({
        workspaceRoot: root,
        stateRoot,
        proxy: '',
        remote: 'origin',
        branch: 'main',
        message: 'content: 待发布',
        files: ['content/diary/diary-one.md'],
        confirmed: true
      })
    ).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' })

    // 阻断路径绝不产生提交
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(head)
    expect(readPublishState(stateRoot).phase).toBe('idle')

    // 恢复路径：--ff-only 拉取后 behind 归零
    const recovered = await pullRecover({ workspaceRoot: root, proxy: '', remote: 'origin', branch: 'main' })
    expect(recovered.behind).toBe(0)
  })

  it('无远端时：提交成功但 push 失败 => committed-not-pushed（可重试）', async () => {
    writeRepoFile(root, 'content/diary/diary-one.md', '---\ntitle: "待发布"\nsummary: "摘要"\ndate: 2026-01-02\n---\n\n正文二\n')
    const head = git(root, ['rev-parse', 'HEAD']).trim()

    const state = await publish({
      workspaceRoot: root,
      stateRoot,
      proxy: '',
      remote: 'origin',
      branch: 'main',
      message: 'content: 待发布',
      files: ['content/diary/diary-one.md'],
      confirmed: true
    })

    expect(state.phase).toBe('committed-not-pushed')
    expect(state.pushed).toBe(false)
    expect(state.commitSha).toBeTruthy()
    expect(state.error).toBeTruthy()
    expect(git(root, ['rev-parse', 'HEAD']).trim()).not.toBe(head)

    const retried = await retryPush({ workspaceRoot: root, stateRoot, proxy: '', remote: 'origin', branch: 'main' })
    expect(retried.phase).toBe('committed-not-pushed')
    expect(retried.pushed).toBe(false)
  })

  it('有远端时：提交并推送成功 => pushed（commit 只含清单）', async () => {
    const remote = makeRemote()
    git(root, ['remote', 'add', 'origin', remote])
    git(root, ['push', '-u', 'origin', 'main'])

    writeRepoFile(root, 'content/blog/post-one.md', '---\ntitle: "已发布"\ndescription: "摘要"\ndate: 2026-01-01\n---\n\n正文一\n')

    const state = await publish({
      workspaceRoot: root,
      stateRoot,
      proxy: '',
      remote: 'origin',
      branch: 'main',
      message: 'content: 更新 blog',
      files: ['content/blog/post-one.md'],
      confirmed: true
    })

    expect(state.phase).toBe('pushed')
    expect(state.pushed).toBe(true)
    expect(state.error).toBeNull()
    expect(state.files).toEqual(['content/blog/post-one.md'])

    // 远端确实收到了这个提交
    const remoteHead = execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim()
    expect(remoteHead).toBe(state.commitSha)
  })

  it('确认但清单为空 => GIT_UNSAFE_PATH（禁止全量提交）', async () => {
    writeRepoFile(root, 'content/blog/post-one.md', '---\ntitle: "A"\ndescription: "摘要"\ndate: 2026-01-01\n---\n\n正文一\n')
    await expect(
      publish({
        workspaceRoot: root,
        stateRoot,
        proxy: '',
        remote: 'origin',
        branch: 'main',
        message: 'content: A',
        files: [],
        confirmed: true
      })
    ).rejects.toMatchObject({ code: 'GIT_UNSAFE_PATH' })
  })
})

describe('一键回滚（P5 可选：git revert 只追加、不改写历史）', () => {
  /** 建远端 + 发布一次 blog 改动，返回已推送的发布状态 */
  async function publishOne() {
    const remote = makeRemote()
    git(root, ['remote', 'add', 'origin', remote])
    git(root, ['push', '-u', 'origin', 'main'])
    writeRepoFile(
      root,
      'content/blog/post-one.md',
      '---\ntitle: "改过的标题"\ndescription: "摘要"\ndate: 2026-01-01\n---\n\n新正文\n'
    )
    const published = await publish({
      workspaceRoot: root,
      stateRoot,
      proxy: '',
      remote: 'origin',
      branch: 'main',
      message: 'content: 更新 blog',
      files: ['content/blog/post-one.md'],
      confirmed: true
    })
    return { remote, published }
  }

  it('生成反向提交：内容还原、原提交仍在历史中、远端收到反向提交', async () => {
    const { remote, published } = await publishOne()
    expect(published.phase).toBe('pushed')

    const rolled = await rollbackLast({
      workspaceRoot: root,
      stateRoot,
      proxy: '',
      remote: 'origin',
      branch: 'main',
      confirmed: true
    })

    expect(rolled.phase).toBe('pushed')
    expect(rolled.pushed).toBe(true)
    expect(rolled.commitSha).toBeTruthy()
    expect(rolled.commitSha).not.toBe(published.commitSha)
    expect(rolled.message).toContain('revert:')

    // 内容回到发布前
    expect(readFileSync(join(root, 'content/blog/post-one.md'), 'utf8')).toBe(
      VALID_FILES['content/blog/post-one.md']
    )
    // 原发布提交仍是新提交的祖先 => 历史被追加而非 reset/强推（merge-base 非祖先时 exit≠0 会抛错）
    git(root, ['merge-base', '--is-ancestor', String(published.commitSha), 'HEAD'])

    // 远端 HEAD = 反向提交，且原发布提交仍在远端历史里
    const remoteHead = execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim()
    expect(remoteHead).toBe(rolled.commitSha)
    execFileSync('git', ['merge-base', '--is-ancestor', String(published.commitSha), 'main'], { cwd: remote })
  })

  it('未确认 => CONFIRM_REQUIRED，零副作用', async () => {
    const { published } = await publishOne()
    const head = git(root, ['rev-parse', 'HEAD']).trim()

    await expect(
      rollbackLast({
        workspaceRoot: root,
        stateRoot,
        proxy: '',
        remote: 'origin',
        branch: 'main',
        confirmed: false
      })
    ).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })

    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(head)
    expect(readPublishState(stateRoot).commitSha).toBe(published.commitSha)
  })

  it('没有发布记录 => GIT_FAILED，不产生提交', async () => {
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    await expect(
      rollbackLast({
        workspaceRoot: root,
        stateRoot,
        proxy: '',
        remote: 'origin',
        branch: 'main',
        confirmed: true
      })
    ).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(head)
  })

  it('拒绝把任意字符串当作 SHA（防参数注入）', async () => {
    for (const bad of ['--hard', 'HEAD', 'HEAD~1', 'not-a-sha', '']) {
      await expect(revertCommit(root, '', { sha: bad })).rejects.toMatchObject({ code: 'GIT_FAILED' })
    }
  })

  it('push=false => 只产生本地反向提交，可再用「重试推送」补推', async () => {
    const { remote, published } = await publishOne()

    const rolled = await rollbackLast({
      workspaceRoot: root,
      stateRoot,
      proxy: '',
      remote: 'origin',
      branch: 'main',
      confirmed: true,
      push: false
    })

    expect(rolled.phase).toBe('committed-not-pushed')
    expect(rolled.pushed).toBe(false)
    const remoteHead = execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim()
    expect(remoteHead).toBe(published.commitSha)

    const retried = await retryPush({
      workspaceRoot: root,
      stateRoot,
      proxy: '',
      remote: 'origin',
      branch: 'main'
    })
    expect(retried.phase).toBe('pushed')
    expect(retried.commitSha).toBe(rolled.commitSha)
  })
})