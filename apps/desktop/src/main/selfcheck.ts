import { app } from 'electron'

/**
 * 自检模式（P0 验收用）：CMS_SELFCHECK=1 时，主进程等待 renderer 回报 ready，
 * 打印一行结构化结果后自动退出，用于在无人值守下验证
 * 「Electron 启动 → sandbox 渲染进程加载 preload → 白名单 IPC 打通」整条链路。
 * 普通开发/使用时不生效。
 */

const enabled = process.env.CMS_SELFCHECK === '1'

let timer: NodeJS.Timeout | null = null
let finished = false

export function isSelfcheck(): boolean {
  return enabled
}

export function armSelfcheck(timeoutMs = 45000): void {
  if (!enabled) return
  timer = setTimeout(() => {
    console.log('[cms] SELFCHECK_FAIL renderer 未在超时内回报 ready')
    app.exit(2)
  }, timeoutMs)
}

export function completeSelfcheck(result: unknown): void {
  if (!enabled || finished) return
  finished = true
  if (timer) clearTimeout(timer)
  console.log('[cms] SELFCHECK_OK ' + JSON.stringify(result))
  setTimeout(() => app.exit(0), 200)
}

export function failSelfcheck(reason: string): void {
  if (!enabled || finished) return
  finished = true
  if (timer) clearTimeout(timer)
  console.log('[cms] SELFCHECK_FAIL ' + reason)
  app.exit(1)
}