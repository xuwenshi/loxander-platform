import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentChangeEvent } from '../contentWatcherService'
import type { PublishState } from '../publishService'
import {
  autoPublishMessage,
  createAutoPublisher,
  decideAutoPublish,
  filterContentMd,
  type AutoPublishDeps
} from '../autoPublishService'

/**
 * 线上自动发布的门禁：纯函数（过滤 / 决策 / 消息）+ 注入式服务行为
 * （debounce 合并、抑制窗口丢弃、hold 跳过、跳过已删除路径）。
 */

function changeEvent(paths: string[]): ContentChangeEvent {
  return { workspaceRoot: 'C:/ws', paths, at: new Date().toISOString() }
}

function pushedState(files: string[]): PublishState {
  return {
    phase: 'pushed',
    commitSha: 'abc1234',
    branch: 'main',
    remote: 'origin',
    message: 'content: 自动发布',
    files,
    pushed: true,
    error: null,
    updatedAt: new Date().toISOString()
  }
}

function makeDeps(overrides: Partial<AutoPublishDeps> = {}): AutoPublishDeps {
  return {
    isEnabled: () => true,
    getDebounceMs: () => 4000,
    pathExists: () => true,
    preflight: async () => ({ blocking: 0, contentFiles: ['content/blog/a.md', 'content/blog/b.md'] }),
    publish: async ({ files }) => pushedState(files),
    onEvent: () => {},
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('filterContentMd：只保留 content/ 下的 .md', () => {
  it('丢弃非内容目录与非 md 文件', () => {
    expect(filterContentMd(['content/blog/a.md', 'content/blog/a.txt', 'src/x.ts', 'content/diary/b.MD'])).toEqual([
      'content/blog/a.md',
      'content/diary/b.MD'
    ])
  })

  it('反斜杠路径也会被归一后再判断', () => {
    expect(filterContentMd(['content\\blog\\a.md'])).toEqual(['content/blog/a.md'])
  })
})

describe('decideAutoPublish：发布前门禁', () => {
  const base = { enabled: true, running: false, hold: false, preflightBlocking: 0, quiet: false }

  it('关闭时跳过', () => {
    const decision = decideAutoPublish({ ...base, enabled: false })
    expect(decision.action).toBe('skip')
    expect(decision.reason).toContain('关闭')
  })

  it('上一次仍在进行时跳过', () => {
    expect(decideAutoPublish({ ...base, running: true }).action).toBe('skip')
  })

  it('hold 时跳过', () => {
    expect(decideAutoPublish({ ...base, hold: true }).action).toBe('skip')
  })

  it('预检有阻断时跳过', () => {
    const decision = decideAutoPublish({ ...base, preflightBlocking: 2 })
    expect(decision.action).toBe('skip')
    expect(decision.reason).toContain('2')
  })

  it('全部条件满足时允许发布', () => {
    expect(decideAutoPublish(base)).toEqual({ action: 'publish', reason: null })
  })
})

describe('autoPublishMessage：提交消息格式', () => {
  it('含 content: 前缀、篇数与本地时间', () => {
    const message = autoPublishMessage(['content/blog/a.md', 'content/blog/b.md'], '2026-10-13T09:30:00')
    expect(message).toContain('content:')
    expect(message).toContain('2 篇')
    expect(message).toContain('2026-10-13 09:30')
  })
})

describe('createAutoPublisher：注入式行为', () => {
  it('debounce 合并连续事件，只发布一次', async () => {
    vi.useFakeTimers()
    const publish = vi.fn(async ({ files }: { files: string[] }) => pushedState(files))
    const publisher = createAutoPublisher(makeDeps({ publish }))

    publisher.onContentChanged(changeEvent(['content/blog/a.md']))
    vi.advanceTimersByTime(1000)
    // 第二个事件重置 debounce 计时器，两个路径一起提交
    publisher.onContentChanged(changeEvent(['content/blog/b.md']))
    await vi.advanceTimersByTimeAsync(4000)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0].files).toEqual(['content/blog/a.md', 'content/blog/b.md'])
  })

  it('抑制窗口内的事件被直接丢弃', async () => {
    vi.useFakeTimers()
    const publish = vi.fn(async ({ files }: { files: string[] }) => pushedState(files))
    const publisher = createAutoPublisher(makeDeps({ publish }))

    publisher.suppress(5000)
    publisher.onContentChanged(changeEvent(['content/blog/a.md']))
    await vi.advanceTimersByTimeAsync(10000)
    expect(publish).not.toHaveBeenCalled()
  })

  it('hold 期间跳过并广播可读原因（绝不静默）', async () => {
    vi.useFakeTimers()
    const publish = vi.fn(async ({ files }: { files: string[] }) => pushedState(files))
    const onEvent = vi.fn()
    const publisher = createAutoPublisher(makeDeps({ publish, onEvent }))

    publisher.setHold(true)
    publisher.onContentChanged(changeEvent(['content/blog/a.md']))
    await vi.advanceTimersByTimeAsync(4000)

    expect(publish).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'skipped' }))
  })

  it('跳过已不在磁盘上的路径（不把基线里的删除项带进提交）', async () => {
    vi.useFakeTimers()
    const publish = vi.fn(async ({ files }: { files: string[] }) => pushedState(files))
    const publisher = createAutoPublisher(
      makeDeps({
        publish,
        // 只有 a.md 还在磁盘上，b.md 已被删除
        pathExists: (path) => path === 'content/blog/a.md',
        preflight: async () => ({ blocking: 0, contentFiles: ['content/blog/a.md', 'content/blog/b.md'] })
      })
    )

    publisher.onContentChanged(changeEvent(['content/blog/a.md', 'content/blog/b.md']))
    await vi.advanceTimersByTimeAsync(4000)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0].files).toEqual(['content/blog/a.md'])
  })

  it('预检阻断时跳过并广播原因', async () => {
    vi.useFakeTimers()
    const publish = vi.fn(async ({ files }: { files: string[] }) => pushedState(files))
    const onEvent = vi.fn()
    const publisher = createAutoPublisher(
      makeDeps({ publish, onEvent, preflight: async () => ({ blocking: 3, contentFiles: [] }) })
    )

    publisher.onContentChanged(changeEvent(['content/blog/a.md']))
    await vi.advanceTimersByTimeAsync(4000)

    expect(publish).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'skipped', reason: expect.stringContaining('3') })
    )
  })

  it('发布成功后广播 published 事件并带上实际文件清单', async () => {
    vi.useFakeTimers()
    const onEvent = vi.fn()
    const publisher = createAutoPublisher(makeDeps({ onEvent }))

    publisher.onContentChanged(changeEvent(['content/blog/a.md']))
    await vi.advanceTimersByTimeAsync(4000)

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'published',
        files: ['content/blog/a.md'],
        commitMessage: expect.stringContaining('content:')
      })
    )
  })
})
