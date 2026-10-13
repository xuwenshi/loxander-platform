import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 本地实时预览（A）：把博客仓库的 `next dev` 拉起来，供 renderer 里的 <webview> 加载真实页面。
 *
 * 设计要点：
 * - 直接 `spawn(node, [next bin, 'dev', ...])`，不经 shell：Windows 上可精确拿到 pid 做树杀。
 * - 不 import electron：node 可执行文件、端口、回调节点全部由调用方注入，纯函数部分可直接单测。
 * - 就绪信号取 stdout 里的 `Local:` / `Ready in`；Next 遇端口占用会自增端口，
 *   所以**实际 origin 以 stdout 解析结果为准**，不能假设等于请求端口。
 * - 停止必须 `taskkill /PID <pid> /T /F`（Next 会派生子进程，child.kill() 清不干净）。
 *   杀进程用 spawnSync：这样 `will-quit` 里不 await 也能保证同步收尾。
 */

/** 预览默认端口（可被 settings.previewPort 覆盖） */
export const DEFAULT_PREVIEW_PORT = 3210
/** 启动就绪超时：冷启动编译可能较慢，给足 60s */
export const READY_TIMEOUT_MS = 60_000
/** 日志环形缓冲上限：行数与字符数任一超限即从头上丢弃 */
const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 64 * 1024

export type DevServerState = 'stopped' | 'starting' | 'ready' | 'error'

export interface DevServerStatus {
  state: DevServerState
  /** dev server 进程 pid（未运行时为 null） */
  pid: number | null
  /** 实际可用的 origin（如 http://localhost:3210），未解析到为 null */
  origin: string | null
  /** 实际端口（Next 自增后以回传为准） */
  port: number | null
  /** 错误/提示信息（ready 时为 null） */
  message: string | null
}

export interface DevServerHandle {
  /** 启动并等待就绪/失败（幂等：已在运行则直接返回当前状态） */
  start: () => Promise<DevServerStatus>
  /** 停止（幂等；内部用 taskkill 同步收尾，可安全地在 will-quit 里不 await 调用） */
  stop: () => Promise<DevServerStatus>
  /** 先停再起 */
  restart: () => Promise<DevServerStatus>
  /** 当前状态快照（不同步、不阻塞） */
  status: () => DevServerStatus
  /** 环形缓冲里的日志文本（供 UI「查看日志」） */
  logs: () => string
}

export interface DevServerOptions {
  /** 博客仓库根目录（含 node_modules/next 与 content/） */
  workspaceRoot: string
  /** 期望端口；被占用时以 stdout 回传为准 */
  port: number
  /** node 可执行文件；空 = 用 Electron 内置 node（见 resolveNodeExe） */
  nodePath?: string
  /** 状态变化回调（renderer 广播 / 白名单登记都用它） */
  onEvent?: (status: DevServerStatus) => void
}

/** 去掉 Next 日志里的 ANSI 色码（纯函数，便于单测） */
export function stripAnsi(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
}

export interface ParsedDevUrl {
  origin: string | null
  port: number | null
}

/**
 * 从 Next stdout 里解析实际 origin / 端口（纯函数）。
 * 支持两类线索：
 * 1. `- Local: http://localhost:3210`（正常就绪行）；
 * 2. `Port 3210 is in use, trying 3211 instead`（端口自增提示，此时还没有 Local 行）。
 */
export function parseDevServerUrl(text: string): ParsedDevUrl {
  const clean = stripAnsi(text)
  const local = /(https?:\/\/localhost:(\d+)|https?:\/\/127\.0\.0\.1:(\d+))/i.exec(clean)
  if (local) {
    return { origin: local[1], port: Number(local[2] ?? local[3]) }
  }
  const retry = /Port\s+\d+\s+is\s+in\s+use,\s*trying\s+(\d+)\s+instead/i.exec(clean)
  if (retry) return { origin: null, port: Number(retry[1]) }
  return { origin: null, port: null }
}

/** 空闲端口探测（纯函数）：从 preferred 起第一个不在 occupied 里的端口 */
export function pickPort(preferred: number, occupied: readonly number[]): number {
  const used = new Set(occupied)
  let port = Math.max(1, Math.round(preferred))
  while (used.has(port) && port < 65_535) port += 1
  return port
}

/**
 * 解析运行 Next 的可执行文件与附加环境变量。
 * Electron 主进程的 process.execPath 是 electron 本体而非 node，直接用它跑 next 会失败；
 * 置 `ELECTRON_RUN_AS_NODE=1` 可让该可执行文件以纯 node 模式运行，无需用户另装 node。
 * 用户在设置里显式给了 nodePath 则优先使用。
 */
function resolveNodeExe(nodePath?: string): { exe: string; extraEnv: NodeJS.ProcessEnv } {
  const custom = (nodePath ?? '').trim()
  if (custom) return { exe: custom, extraEnv: {} }
  return { exe: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
}

/** 同步杀进程树：Windows 用 taskkill /T /F（含派生进程）；POSIX 退化为 SIGTERM */
function killTreeSync(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* 进程可能已自行退出，忽略 */
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* 已退出 */
  }
}

export function createDevServer(options: DevServerOptions): DevServerHandle {
  const { workspaceRoot, onEvent } = options
  const preferredPort = Math.max(1024, Math.min(65_535, Math.round(options.port)))
  const nodePath = options.nodePath

  let child: ChildProcess | null = null
  let state: DevServerState = 'stopped'
  let origin: string | null = null
  let actualPort: number | null = null
  let message: string | null = null

  const lines: string[] = []
  let logChars = 0

  let readyTimer: NodeJS.Timeout | null = null
  /** 让 start() 的 Promise 在「就绪 / 失败 / 超时 / 被停」时结清，避免悬挂 */
  let pendingSettle: (() => void) | null = null

  function snapshot(): DevServerStatus {
    return { state, pid: child?.pid ?? null, origin, port: actualPort, message }
  }

  function emit(): void {
    onEvent?.(snapshot())
  }

  function clearTimer(): void {
    if (readyTimer) {
      clearTimeout(readyTimer)
      readyTimer = null
    }
  }

  function pushLog(chunk: string): void {
    const clean = stripAnsi(chunk).replace(/\r/g, '')
    for (const line of clean.split('\n')) {
      if (!line.trim()) continue
      lines.push(line)
      logChars += line.length + 1
    }
    // 环形缓冲：行数或总字符数超限就从头部丢弃
    while (lines.length > MAX_LOG_LINES || logChars > MAX_LOG_CHARS) {
      const removed = lines.shift()
      if (removed === undefined) break
      logChars -= removed.length + 1
    }
  }

  function start(): Promise<DevServerStatus> {
    // 已在运行/启动中：直接回当前快照，不重复拉起
    if (child && state !== 'error' && state !== 'stopped') return Promise.resolve(snapshot())

    // 每次启动重置日志与解析结果，避免混入上一次进程的日志
    lines.length = 0
    logChars = 0
    origin = null
    actualPort = preferredPort
    message = null

    const binPath = join(workspaceRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
    if (!existsSync(binPath)) {
      child = null
      state = 'error'
      actualPort = preferredPort
      message = `找不到 Next 可执行文件：${binPath}`
      emit()
      return Promise.resolve(snapshot())
    }

    return new Promise<DevServerStatus>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimer()
        pendingSettle = null
        resolve(snapshot())
      }
      pendingSettle = settle

      state = 'starting'
      emit()

      const { exe, extraEnv } = resolveNodeExe(nodePath)
      let proc: ChildProcess
      try {
        proc = spawn(exe, [binPath, 'dev', '--port', String(preferredPort)], {
          cwd: workspaceRoot,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...extraEnv, NEXT_TELEMETRY_DISABLED: '1' }
        })
      } catch (err) {
        state = 'error'
        message = `无法启动 Next dev server：${err instanceof Error ? err.message : String(err)}`
        emit()
        settle()
        return
      }
      child = proc

      proc.stdout?.on('data', (buf: Buffer) => {
        const text = buf.toString('utf8')
        pushLog(text)
        const parsed = parseDevServerUrl(text)
        if (parsed.port) actualPort = parsed.port
        if (parsed.origin) origin = parsed.origin
        if (state === 'starting' && (parsed.origin !== null || /Ready in|Local:/.test(text))) {
          state = 'ready'
          message = null
          emit()
          settle()
          return
        }
        emit()
      })

      proc.stderr?.on('data', (buf: Buffer) => {
        pushLog(buf.toString('utf8'))
      })

      proc.on('error', (err) => {
        state = 'error'
        message = `无法启动 Next dev server：${err.message}`
        emit()
        settle()
      })

      proc.on('exit', (code) => {
        child = null
        if (state === 'ready' || state === 'starting') {
          state = 'error'
          message = `Next dev server 已退出（code ${code ?? 'null'}）`
          emit()
        }
        settle()
      })

      readyTimer = setTimeout(() => {
        if (state === 'starting') {
          state = 'error'
          message = `启动超时（${READY_TIMEOUT_MS / 1000}s 内未就绪）`
          emit()
          settle()
        }
      }, READY_TIMEOUT_MS)
    })
  }

  async function stop(): Promise<DevServerStatus> {
    clearTimer()
    const proc = child
    const pid = proc?.pid
    child = null
    if (pid !== undefined) killTreeSync(pid)
    state = 'stopped'
    origin = null
    actualPort = null
    message = null
    emit()
    // 若有 start() 还在等待，同步结清
    pendingSettle?.()
    return snapshot()
  }

  async function restart(): Promise<DevServerStatus> {
    await stop()
    return start()
  }

  return {
    start,
    stop,
    restart,
    status: snapshot,
    logs: () => lines.join('\n')
  }
}
