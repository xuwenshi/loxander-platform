import type { ContentChangeEvent } from './contentWatcherService'
import type { PublishState } from './publishService'

/**
 * 线上自动发布（B）：内容保存 / content/ 变化后，debounce 合并 → 预检 → 提交 → 推送 → 回读部署。
 *
 * 关键约束（都是踩过的坑）：
 * - **只提交本次事件涉及的 content/*.md**，且跳过已经不在磁盘上的路径。
 *   绝不能把工作区基线里的其他改动（例如两个「已删除未提交」的 diary）一起提交，否则会误删线上内容。
 * - **防环**：pull --ff-only / git revert 会改写 content/，进而触发 watcher；
 *   publish / retryPush / rollback / pull 期间及其后 1.5s 走抑制窗口，直接丢弃 watcher 事件。
 * - **绝不静默**：每次决策（发布成功 / 跳过 / 失败）都通过 onEvent 回传，UI 必须显式展示。
 * - 不 import electron：所有特权动作（预检 / 发布 / 回读）由调用方注入，纯函数可直接单测。
 */

/** 抑制窗口默认时长：覆盖操作本身 + 其后 1.5s（由调用方在操作前后各调一次 suppress 覆盖全程） */
export const SUPPRESS_MS = 1500

/** 只保留 content/ 下的 .md（纯函数）：丢弃 content/blog/a.txt、src/x.ts 之类 */
export function filterContentMd(paths: readonly string[]): string[] {
  const result: string[] = []
  for (const raw of paths) {
    const path = String(raw).replace(/\\/g, '/')
    if (!path.startsWith('content/')) continue
    if (!path.toLowerCase().endsWith('.md')) continue
    result.push(path)
  }
  return result
}

export interface AutoPublishDecisionInput {
  enabled: boolean
  /** 上一次自动发布是否仍在进行（单飞互斥） */
  running: boolean
  /** renderer 检测到冲突 / 外部改动时置位的暂停开关 */
  hold: boolean
  /** 预检报告的阻断项数量 */
  preflightBlocking: number
  /** 是否处于抑制窗口（防自我触发） */
  quiet: boolean
}

export interface AutoPublishDecision {
  action: 'publish' | 'skip'
  /** skip 时的中文原因（直接展示给用户，绝不静默） */
  reason: string | null
}

/** 发布前的门禁决策（纯函数）：任一跳过条件命中即 skip，并给出可读原因 */
export function decideAutoPublish(input: AutoPublishDecisionInput): AutoPublishDecision {
  if (!input.enabled) return { action: 'skip', reason: '自动发布已关闭' }
  if (input.quiet) return { action: 'skip', reason: '处于发布抑制窗口，已忽略本次触发' }
  if (input.running) return { action: 'skip', reason: '上一次自动发布仍在进行中' }
  if (input.hold) return { action: 'skip', reason: '检测到冲突或外部改动，已暂停自动发布' }
  if (input.preflightBlocking > 0) {
    return { action: 'skip', reason: `预检有 ${input.preflightBlocking} 项阻断，已跳过自动发布` }
  }
  return { action: 'publish', reason: null }
}

/** 自动发布的 commit message（纯函数）：固定 content: 前缀 + 篇数 + 本地时间 */
export function autoPublishMessage(files: readonly string[], atISO: string): string {
  const date = new Date(atISO)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
  return `content: 自动发布 ${files.length} 篇 · ${stamp}`
}

/** 一次自动发布的决策/结果事件，经 IPC 广播给 renderer 显式展示 */
export interface AutoPublishEvent {
  kind: 'skipped' | 'published' | 'error'
  /** skip 原因 / 错误信息 */
  reason: string | null
  /** 本次实际参与提交的文件（发布成功时有值） */
  files: string[]
  /** 提交消息（发布成功时有值） */
  commitMessage: string | null
  /** 发布后的状态（发布成功时有值） */
  state: PublishState | null
  at: string
}

export interface AutoPublishDeps {
  /** 是否启用（每次决策读一次，支持运行中热切换） */
  isEnabled: () => boolean
  /** debounce 窗口毫秒（读设置） */
  getDebounceMs: () => number
  /** 路径是否仍存在（跳过被删除的文件，避免误提交基线里的删除项） */
  pathExists: (relativePath: string) => boolean
  /** 运行预检，取阻断数与可提交的内容文件清单 */
  preflight: () => Promise<{ blocking: number; contentFiles: string[] }>
  /** 执行发布（本服务固定以 confirmed=true 调用，绕开人工确认卡） */
  publish: (input: { message: string; files: string[] }) => Promise<PublishState>
  /** 就绪状态事件出口 */
  onEvent: (event: AutoPublishEvent) => void
  /** 注入时间源（测试可固定） */
  now?: () => Date
}

export interface AutoPublisher {
  /** content/ 变更入口：debounce 合并后决策并发布 */
  onContentChanged: (event: ContentChangeEvent) => void
  /** 进入抑制窗口：操作期间及其后 ms 内丢弃 watcher 事件（防自我触发） */
  suppress: (ms?: number) => void
  /** 置位 / 解除 hold（renderer 检测到冲突或外部改动时调用） */
  setHold: (hold: boolean) => void
  /** 是否正在执行自动发布 */
  isRunning: () => boolean
}

export function createAutoPublisher(deps: AutoPublishDeps): AutoPublisher {
  /** 待发布的 content/*.md（跨多次事件累积，debounce 后一次性处理） */
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let running = false
  /** running 期间又来了事件：记下来，本轮结束后立刻再排一次 */
  let queued = false
  let hold = false
  let suppressUntil = 0

  const nowMs = (): number => (deps.now ? deps.now().getTime() : Date.now())
  const nowDate = (): Date => (deps.now ? deps.now() : new Date())

  function emit(event: AutoPublishEvent): void {
    deps.onEvent(event)
  }

  function skipped(reason: string, files: string[]): void {
    emit({ kind: 'skipped', reason, files, commitMessage: null, state: null, at: nowDate().toISOString() })
  }

  function schedule(delayMs: number): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void attempt()
    }, delayMs)
  }

  async function attempt(): Promise<void> {
    if (running) {
      queued = true
      return
    }
    if (pending.size === 0) return

    const at = nowDate()
    // 抑制窗口：这些事件多半是 pull/revert 自产生的，直接丢弃累积路径
    if (at.getTime() < suppressUntil) {
      pending.clear()
      return
    }

    const enabled = deps.isEnabled()
    if (!enabled) {
      pending.clear()
      skipped('自动发布已关闭', [])
      return
    }
    if (hold) {
      skipped('检测到冲突或外部改动，已暂停自动发布', [])
      return
    }

    running = true
    try {
      // 只保留仍在磁盘上的路径（被删除的文件不能提交，否则会连带删掉线上内容）
      const alive = [...pending].filter((path) => deps.pathExists(path))
      const goneCount = pending.size - alive.length
      pending.clear()
      if (alive.length === 0) {
        skipped(
          goneCount > 0 ? `本次变更的 ${goneCount} 个文件已不在磁盘上，无内容可发布` : '没有待发布的内容',
          []
        )
        return
      }

      let report: { blocking: number; contentFiles: string[] }
      try {
        report = await deps.preflight()
      } catch (err) {
        emit({
          kind: 'error',
          reason: err instanceof Error ? err.message : String(err),
          files: [],
          commitMessage: null,
          state: null,
          at: nowDate().toISOString()
        })
        return
      }

      const decision = decideAutoPublish({
        enabled,
        running: false,
        hold,
        preflightBlocking: report.blocking,
        quiet: false
      })
      if (decision.action === 'skip') {
        skipped(decision.reason ?? '已跳过', [])
        return
      }

      // 与预检清单取交集：确保只提交「本次事件 + 当前确属内容改动」的文件
      const files = filterContentMd(alive).filter((path) => report.contentFiles.includes(path))
      if (files.length === 0) {
        skipped('本次变更的文件不在待提交内容清单内', [])
        return
      }

      const message = autoPublishMessage(files, at.toISOString())
      let state: PublishState
      try {
        state = await deps.publish({ message, files })
      } catch (err) {
        emit({
          kind: 'error',
          reason: err instanceof Error ? err.message : String(err),
          files,
          commitMessage: message,
          state: null,
          at: nowDate().toISOString()
        })
        return
      }

      emit({
        kind: 'published',
        reason: state.phase === 'pushed' ? null : (state.error?.message ?? '已提交但推送失败'),
        files: state.files.length > 0 ? state.files : files,
        commitMessage: message,
        state,
        at: nowDate().toISOString()
      })
    } finally {
      running = false
      if (queued) {
        queued = false
        if (pending.size > 0) schedule(0)
      }
    }
  }

  function onContentChanged(event: ContentChangeEvent): void {
    // 抑制窗口内的事件直接丢弃（不进 pending，避免稍后被误发）
    if (nowMs() < suppressUntil) return
    const paths = filterContentMd(event.paths)
    if (paths.length === 0) return
    for (const path of paths) pending.add(path)
    schedule(Math.max(0, deps.getDebounceMs()))
  }

  function suppress(ms = SUPPRESS_MS): void {
    suppressUntil = nowMs() + Math.max(0, ms)
  }

  function setHold(next: boolean): void {
    hold = next
  }

  return {
    onContentChanged,
    suppress,
    setHold,
    isRunning: () => running
  }
}
