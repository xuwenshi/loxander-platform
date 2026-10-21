import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CmsError } from '../errors'
import {
  commitFiles,
  getStatus,
  pullFastForward,
  pushBranch,
  revertCommit,
  type GitStatus
} from './gitService'
import { runPreflight, type PreflightReport } from './preflightService'

/**
 * 发布状态机（P2）。
 *
 * 阶段：
 *   idle                  —— 无待处理的发布
 *   committed-not-pushed  —— 已在本地 commit，但 push 失败（可幂等重试 push）
 *   pushed                —— 已推送远端（P3 据此按 SHA 回读部署状态）
 *
 * 关键：**取消 / 预检阻断 => 零副作用**（不写盘、不 commit、不 push）；
 * 只有 `confirmed === true` 才会进入 commit。push 失败**不抛异常**，而是把错误写进状态，
 * 让 UI 展示「已提交未推送 + 重试推送」，避免用户以为改动丢失。
 */

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

export interface PublishParams {
  workspaceRoot: string
  /** CMS 自己的状态目录（userData），绝不写进博客仓库 */
  stateRoot: string
  proxy: string
  remote: string
  branch: string
  message: string
  files: unknown
  /** 人工确认闸门：必须为 true 才允许 commit */
  confirmed: boolean
}

export interface RetryPushParams {
  workspaceRoot: string
  stateRoot: string
  proxy: string
  remote: string
  branch: string
}

const EMPTY: Omit<PublishState, 'branch' | 'remote' | 'updatedAt'> = {
  phase: 'idle',
  commitSha: null,
  message: null,
  files: [],
  pushed: false,
  error: null
}

function stateFile(stateRoot: string): string {
  return join(stateRoot, 'publish-state.json')
}

function toError(err: unknown): PublishError {
  if (err instanceof CmsError) return { code: err.code, message: err.message, hint: err.hint }
  return { code: 'GIT_FAILED', message: err instanceof Error ? err.message : String(err) }
}

export function readPublishState(stateRoot: string, branch = '', remote = ''): PublishState {
  try {
    const file = stateFile(stateRoot)
    if (!existsSync(file)) {
      return { ...EMPTY, branch, remote, updatedAt: new Date().toISOString() }
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PublishState>
    return {
      ...EMPTY,
      phase: parsed.phase ?? 'idle',
      commitSha: parsed.commitSha ?? null,
      branch: parsed.branch ?? branch,
      remote: parsed.remote ?? remote,
      message: parsed.message ?? null,
      files: parsed.files ?? [],
      pushed: parsed.pushed ?? false,
      error: parsed.error ?? null,
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    }
  } catch {
    return { ...EMPTY, branch, remote, updatedAt: new Date().toISOString() }
  }
}

function writePublishState(stateRoot: string, state: PublishState): PublishState {
  const file = stateFile(stateRoot)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
  return state
}

export function clearPublishState(stateRoot: string, branch = '', remote = ''): PublishState {
  return writePublishState(stateRoot, {
    ...EMPTY,
    branch,
    remote,
    updatedAt: new Date().toISOString()
  })
}

/** 预检（可在确认卡之前单独调用） */
export async function preflight(params: {
  workspaceRoot: string
  proxy: string
  remote: string
  branch: string
}): Promise<PreflightReport> {
  return runPreflight(params)
}

/**
 * 提交并推送。预检未全绿或未确认时抛错（零副作用）。
 * push 失败时返回 phase = committed-not-pushed 的状态（不抛错）。
 */
export async function publish(params: PublishParams): Promise<PublishState> {
  const { workspaceRoot: root, stateRoot, proxy, remote, branch } = params

  if (params.confirmed !== true) {
    throw new CmsError(
      'CONFIRM_REQUIRED',
      '尚未完成人工确认',
      '请在确认卡中勾选「我已确认变更文件清单」后再提交'
    )
  }

  const report = await runPreflight({ workspaceRoot: root, proxy, remote, branch })
  if (!report.ok) {
    throw new CmsError(
      'PREFLIGHT_FAILED',
      `预检未通过（${report.blocking.length} 项阻断），已阻止发布`,
      report.blocking[0]?.hint ?? report.blocking[0]?.message,
      report
    )
  }

  // 提交（内部对文件清单做安全校验，越界/通配直接拒绝）
  const commit = await commitFiles(root, proxy, { message: params.message, files: params.files })

  let state: PublishState = {
    phase: 'committed-not-pushed',
    commitSha: commit.sha,
    branch: commit.branch || branch,
    remote,
    message: params.message,
    files: commit.files,
    pushed: false,
    error: null,
    updatedAt: new Date().toISOString()
  }
  writePublishState(stateRoot, state)

  try {
    await pushBranch(root, proxy, { remote, branch: state.branch })
    state = { ...state, phase: 'pushed', pushed: true, error: null, updatedAt: new Date().toISOString() }
  } catch (err) {
    state = { ...state, phase: 'committed-not-pushed', pushed: false, error: toError(err), updatedAt: new Date().toISOString() }
  }
  return writePublishState(stateRoot, state)
}

/** 幂等重试 push：仅当状态为 committed-not-pushed 时有意义 */
export async function retryPush(params: RetryPushParams): Promise<PublishState> {
  const current = readPublishState(params.stateRoot, params.branch, params.remote)
  if (current.phase === 'pushed') return current
  if (current.phase !== 'committed-not-pushed') {
    throw new CmsError('GIT_FAILED', '当前没有「已提交未推送」的发布可重试', '请先运行预检并完成一次提交')
  }

  let next: PublishState = current
  try {
    await pushBranch(params.workspaceRoot, params.proxy, {
      remote: current.remote || params.remote,
      branch: current.branch || params.branch
    })
    next = { ...current, phase: 'pushed', pushed: true, error: null, updatedAt: new Date().toISOString() }
  } catch (err) {
    next = { ...current, pushed: false, error: toError(err), updatedAt: new Date().toISOString() }
  }
  return writePublishState(params.stateRoot, next)
}

export interface PullResult extends GitStatus {
  summary: string
}

/** behind > 0 的恢复路径：只允许快进，绝不自动合并/变基（ADR-5） */
export async function pullRecover(params: {
  workspaceRoot: string
  proxy: string
  remote: string
  branch: string
}): Promise<PullResult> {
  const { workspaceRoot: root, proxy, remote, branch } = params
  const result = await pullFastForward(root, proxy, { remote, branch })
  const status = await getStatus(root, proxy)
  return { ...status, summary: result.summary }
}

export interface RollbackParams {
  workspaceRoot: string
  stateRoot: string
  proxy: string
  remote: string
  branch: string
  /** 人工确认闸门：必须为 true 才允许回滚 */
  confirmed: boolean
  /** 是否把反向提交推送到远端（默认 true；本地未推送过的发布无需推送） */
  push?: boolean
}

/**
 * 一键回滚（P5 可选）：对**上一次发布**的提交生成反向提交（`git revert`），绝不改写历史。
 * 未确认或无发布记录时抛错且**零副作用**；推送失败不抛错，而是写入状态，交由「重试推送」继续。
 */
export async function rollbackLast(params: RollbackParams): Promise<PublishState> {
  const { workspaceRoot: root, stateRoot, proxy, remote, branch } = params

  if (params.confirmed !== true) {
    throw new CmsError('CONFIRM_REQUIRED', '尚未完成人工确认', '请阅读回滚提示并确认后再执行')
  }

  const current = readPublishState(stateRoot, branch, remote)
  const sha = current.commitSha
  if (current.phase === 'idle' || !sha) {
    throw new CmsError('GIT_FAILED', '没有可回滚的发布记录', '只有完成过一次发布后才可回滚')
  }

  const revert = await revertCommit(root, proxy, { sha })

  let state: PublishState = {
    phase: 'committed-not-pushed',
    commitSha: revert.revertedSha,
    branch: revert.branch || branch,
    remote,
    message: `revert: ${current.message ?? sha}`,
    files: current.files,
    pushed: false,
    error: null,
    updatedAt: new Date().toISOString()
  }
  writePublishState(stateRoot, state)

  if (params.push === false) return writePublishState(stateRoot, state)

  try {
    await pushBranch(root, proxy, { remote, branch: state.branch })
    state = { ...state, phase: 'pushed', pushed: true, error: null, updatedAt: new Date().toISOString() }
  } catch (err) {
    state = { ...state, pushed: false, error: toError(err), updatedAt: new Date().toISOString() }
  }
  return writePublishState(stateRoot, state)
}